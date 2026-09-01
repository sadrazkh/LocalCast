package edge

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

// peerCacheTTL bounds how long a resolved identity is reused.
//
// WhoIs is a round trip to the local Tailscale daemon. Seeking around a 4K file produces
// dozens of range requests a second from one peer (design spec 5), and doing a local API
// call for every one of them would put a lock-step dependency on tailscaled in the hot path
// of video playback. A short TTL keeps the identity fresh enough that a revoked device is
// re-resolved within seconds, while permissions themselves are re-read from the database on
// every request anyway (spec 3, rule 3), so the cache cannot extend anyone's access.
const peerCacheTTL = 30 * time.Second

// peerResolver maps a connection's remote address to the tailnet peer identity that netedge
// injects. It is an interface so the header handling can be tested without a tailnet.
type peerResolver interface {
	Peer(ctx context.Context, remoteAddr string) string
}

// staticPeer always answers the same identity. Used for tests and as the degenerate case.
type staticPeer string

func (p staticPeer) Peer(context.Context, string) string { return string(p) }

// whoIsResponse and whoIsNode are the two fields of apitype.WhoIsResponse that netedge
// reads, restated locally.
//
// The translation happens in exactly one adapter (tsWhoIs in edge.go), which keeps
// tailscale's wire types out of the request path and lets this file — and its tests — be
// read and exercised without a tailnet. It also confines the blast radius if apitype's
// field names differ from what is assumed here.
type whoIsResponse struct {
	Node *whoIsNode
}

type whoIsNode struct {
	// StableID is per-device and survives a rename. It is what a rate-limit key wants.
	StableID string
	// Name is the MagicDNS FQDN, with the trailing dot the DNS form carries.
	Name string
}

// whoIser is the one lookup the resolver needs.
type whoIser interface {
	WhoIs(ctx context.Context, remoteAddr string) (*whoIsResponse, error)
}

// whoisResolver asks the local Tailscale daemon who is on the other end of a connection.
type whoisResolver struct {
	lc whoIser

	// fallback is used when there is no identity to be had. In Funnel mode that is every
	// request, because traffic arrives from Tailscale's relays.
	fallback string

	ttl time.Duration
	now func() time.Time

	mu    sync.Mutex
	cache map[string]peerCacheEntry
}

type peerCacheEntry struct {
	peer      string
	expiresAt time.Time
}

func newWhoisResolver(lc whoIser, fallback string, now func() time.Time) *whoisResolver {
	if now == nil {
		now = time.Now
	}
	if fallback == "" {
		fallback = protocol.FunnelPeer
	}
	return &whoisResolver{
		lc:       lc,
		fallback: fallback,
		ttl:      peerCacheTTL,
		now:      now,
		cache:    make(map[string]peerCacheEntry),
	}
}

func (r *whoisResolver) Peer(ctx context.Context, remoteAddr string) string {
	key := hostOnly(remoteAddr)
	if key == "" {
		return r.fallback
	}

	now := r.now()
	r.mu.Lock()
	if e, ok := r.cache[key]; ok && now.Before(e.expiresAt) {
		r.mu.Unlock()
		return e.peer
	}
	r.mu.Unlock()

	peer := r.fallback
	if r.lc != nil {
		if who, err := r.lc.WhoIs(ctx, remoteAddr); err == nil && who != nil && who.Node != nil {
			peer = peerIdentity(who.Node.StableID, who.Node.Name, r.fallback)
		}
	}

	r.mu.Lock()
	r.cache[key] = peerCacheEntry{peer: peer, expiresAt: now.Add(r.ttl)}
	r.mu.Unlock()
	return peer
}

// peerIdentity picks the identity to inject from a WhoIs answer.
//
// It takes plain strings rather than the tailscale wire types so the choice can be tested
// without constructing them: StableID first because it is per-device and survives a rename,
// which is what a rate-limit key needs; the MagicDNS name second because it is at least
// stable and readable; the fallback last, because inventing an identity would be worse than
// admitting there is none.
func peerIdentity(stableID, nodeName, fallback string) string {
	if s := strings.TrimSpace(stableID); s != "" {
		return s
	}
	if n := strings.TrimSuffix(strings.TrimSpace(nodeName), "."); n != "" {
		return n
	}
	return fallback
}

// hostOnly strips the port from a "host:port" remote address. WhoIs answers per node, so the
// ephemeral source port must not fragment the cache.
func hostOnly(remoteAddr string) string {
	if remoteAddr == "" {
		return ""
	}
	if host, _, err := net.SplitHostPort(remoteAddr); err == nil {
		return host
	}
	return remoteAddr
}

// ─── the reverse proxy ───────────────────────────────────────────────────────

type peerContextKey struct{}

// proxyHandler terminates the tailnet request and forwards it to the loopback Node server.
type proxyHandler struct {
	rp    *httputil.ReverseProxy
	peers peerResolver
}

// newProxyHandler builds the handler that fronts the Node server.
//
// upstream is a host:port; secret is the value injected as x-lc-edge-secret so the Node
// server can prove the request came through the edge rather than from another process on the
// machine pointing a browser at loopback (design spec 2.1).
func newProxyHandler(upstream, secret string, peers peerResolver, logf logFunc) (http.Handler, error) {
	// Split rather than url.Parse: "http://127.0.0.1:8080" parses happily into a URL whose
	// host is the nonsense "http:", and the mistake would then surface as a dial failure on
	// every request instead of at startup where it can be read.
	host, port, err := net.SplitHostPort(upstream)
	if err != nil {
		return nil, fmt.Errorf("upstream %q must be host:port: %w", upstream, err)
	}
	if host == "" {
		return nil, fmt.Errorf("upstream %q has no host", upstream)
	}
	if n, err := strconv.Atoi(port); err != nil || n < 1 || n > 65535 {
		return nil, fmt.Errorf("upstream %q has no usable port", upstream)
	}
	target := &url.URL{Scheme: "http", Host: upstream}

	if logf == nil {
		logf = func(protocol.LogLevel, string, ...any) {}
	}

	rp := &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)

			// Keep the original Host so the Node server sees the name the client asked for;
			// SetURL would otherwise rewrite it to the loopback address and any absolute
			// URL the server builds would point at 127.0.0.1.
			pr.Out.Host = pr.In.Host

			// Informational only. Behind Funnel the forwarded address is a Tailscale relay,
			// so nothing may rate-limit on it (spec 4.3); x-lc-peer is the authoritative
			// identity and it is set below.
			pr.SetXForwarded()

			// Strip again on the outbound request. sanitizeInbound already removed any
			// client-supplied copy, but doing it here as well means the guarantee does not
			// depend on the two halves staying in the same file.
			pr.Out.Header.Del(protocol.HeaderEdgeSecret)
			pr.Out.Header.Del(protocol.HeaderPeer)

			pr.Out.Header.Set(protocol.HeaderEdgeSecret, secret)
			pr.Out.Header.Set(protocol.HeaderPeer, peerFromContext(pr.In.Context()))
		},

		// FlushInterval is deliberately left at zero. Go's ReverseProxy already flushes
		// immediately for text/event-stream responses, which is what GET /api/v1/events
		// needs (spec 4.1), and forcing immediate flushes for everything else would turn a
		// multi-gigabyte download into one syscall per read.

		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			// A client that abandons a range request is the ordinary case when someone
			// scrubs a video, not an incident. Logging it at error level would bury the
			// real failures under it.
			if errors.Is(err, context.Canceled) || r.Context().Err() != nil {
				return
			}
			logf(protocol.LogWarn, "upstream %s failed for %s %s: %v", upstream, r.Method, r.URL.Path, err)
			writeProxyError(w, http.StatusServiceUnavailable, protocol.ErrCodeEdgeNotReady,
				"the LocalCast server is not answering on loopback")
		},
	}

	return &proxyHandler{rp: rp, peers: peers}, nil
}

func (h *proxyHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	// A client must not be able to forge either header: x-lc-edge-secret is the Node
	// server's proof that a request came through the edge, and x-lc-peer is the only
	// unforgeable rate-limit key behind Funnel. Strip both on the way in, before anything
	// else in this process can observe them, then inject the trusted values in Rewrite.
	sanitizeInbound(r.Header)

	peer := protocol.FunnelPeer
	if h.peers != nil {
		if p := h.peers.Peer(r.Context(), r.RemoteAddr); p != "" {
			peer = p
		}
	}

	h.rp.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), peerContextKey{}, peer)))
}

// sanitizeInbound removes every header netedge is authoritative for.
//
// Header.Del is canonicalising, so one call covers X-LC-Edge-Secret, x-lc-edge-secret and
// every other casing a client might try.
func sanitizeInbound(h http.Header) {
	h.Del(protocol.HeaderEdgeSecret)
	h.Del(protocol.HeaderPeer)
}

func peerFromContext(ctx context.Context) string {
	if p, ok := ctx.Value(peerContextKey{}).(string); ok && p != "" {
		return p
	}
	return protocol.FunnelPeer
}

// writeProxyError answers with the same {error:{code,message}} envelope the Node server
// uses, so a client never has to tell the difference between the two (spec 8).
func writeProxyError(w http.ResponseWriter, status int, code, message string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(protocol.NewAPIError(code, message))
}
