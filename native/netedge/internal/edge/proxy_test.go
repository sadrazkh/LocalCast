package edge

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

const testSecret = "b6f1c0de0f6a4c1e9f2b7a5d3c8e1049"

// captured is what the fake upstream saw.
type captured struct {
	header http.Header
	host   string
	method string
	path   string
}

// newTestProxy wires the handler to a fake Node server and returns both.
func newTestProxy(t *testing.T, peers peerResolver) (http.Handler, *captured) {
	t.Helper()

	got := &captured{}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		got.header = r.Header.Clone()
		got.host = r.Host
		got.method = r.Method
		got.path = r.URL.Path
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(upstream.Close)

	h, err := newProxyHandler(strings.TrimPrefix(upstream.URL, "http://"), testSecret, peers, nil)
	if err != nil {
		t.Fatalf("newProxyHandler: %v", err)
	}
	return h, got
}

// TestProxyInjectsTrustedHeaders is the base case: the Node server must receive exactly the
// secret netedge was given and the identity netedge resolved.
func TestProxyInjectsTrustedHeaders(t *testing.T) {
	h, got := newTestProxy(t, staticPeer("nABC123"))

	req := httptest.NewRequest(http.MethodGet, "http://localcast.tail1234.ts.net/api/v1/me", nil)
	req.RemoteAddr = "100.64.0.7:52344"
	h.ServeHTTP(httptest.NewRecorder(), req)

	if v := got.header.Get(protocol.HeaderEdgeSecret); v != testSecret {
		t.Errorf("%s = %q, want the shared secret", protocol.HeaderEdgeSecret, v)
	}
	if v := got.header.Get(protocol.HeaderPeer); v != "nABC123" {
		t.Errorf("%s = %q, want nABC123", protocol.HeaderPeer, v)
	}
	if got.host != "localcast.tail1234.ts.net" {
		t.Errorf("Host = %q; the upstream must see the name the client asked for", got.host)
	}
	if got.path != "/api/v1/me" {
		t.Errorf("path = %q", got.path)
	}
}

// TestProxyStripsForgedHeaders is the security property this whole file exists for: a client
// that sends either header must not be able to influence what the Node server receives.
//
// The case list includes every casing and duplication trick, because Header.Del is
// canonicalising and a hand-rolled `delete(h, "x-lc-peer")` would not be.
func TestProxyStripsForgedHeaders(t *testing.T) {
	cases := []struct {
		name   string
		forged map[string][]string
	}{
		{
			name: "lowercase",
			forged: map[string][]string{
				"x-lc-edge-secret": {"attacker-secret"},
				"x-lc-peer":        {"nOWNER"},
			},
		},
		{
			name: "canonical casing",
			forged: map[string][]string{
				"X-Lc-Edge-Secret": {"attacker-secret"},
				"X-Lc-Peer":        {"nOWNER"},
			},
		},
		{
			name: "shouting",
			forged: map[string][]string{
				"X-LC-EDGE-SECRET": {"attacker-secret"},
				"X-LC-PEER":        {"nOWNER"},
			},
		},
		{
			name: "repeated values",
			forged: map[string][]string{
				"X-Lc-Peer": {"nOWNER", "nOTHER", "funnel"},
			},
		},
		{
			name: "empty values",
			forged: map[string][]string{
				"X-Lc-Edge-Secret": {""},
				"X-Lc-Peer":        {""},
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			h, got := newTestProxy(t, staticPeer("nREAL"))

			req := httptest.NewRequest(http.MethodGet, "http://localcast.tail1234.ts.net/api/v1/folders", nil)
			req.RemoteAddr = "100.64.0.7:52344"
			for k, vs := range tc.forged {
				for _, v := range vs {
					req.Header.Add(k, v)
				}
			}

			h.ServeHTTP(httptest.NewRecorder(), req)

			if vs := got.header.Values(protocol.HeaderEdgeSecret); len(vs) != 1 || vs[0] != testSecret {
				t.Errorf("%s = %q, want exactly [%q]", protocol.HeaderEdgeSecret, vs, testSecret)
			}
			if vs := got.header.Values(protocol.HeaderPeer); len(vs) != 1 || vs[0] != "nREAL" {
				t.Errorf("%s = %q, want exactly [nREAL]", protocol.HeaderPeer, vs)
			}
			for _, vs := range got.header {
				for _, v := range vs {
					if v == "attacker-secret" || v == "nOWNER" || v == "nOTHER" {
						t.Errorf("a forged value survived somewhere in the headers: %v", got.header)
					}
				}
			}
		})
	}
}

// TestProxyStripsBeforeResolution: the inbound request object itself must be clean, so that
// anything downstream in this process — logging, a future middleware — cannot read the
// forged value either.
func TestProxyStripsBeforeResolution(t *testing.T) {
	var seen atomic.Value
	peers := peerResolverFunc(func(_ context.Context, _ string) string {
		return "nREAL"
	})

	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen.Store(r.Header.Clone())
		w.WriteHeader(http.StatusOK)
	}))
	defer upstream.Close()

	h, err := newProxyHandler(strings.TrimPrefix(upstream.URL, "http://"), testSecret, peers, nil)
	if err != nil {
		t.Fatalf("newProxyHandler: %v", err)
	}

	req := httptest.NewRequest(http.MethodGet, "http://host/api/v1/me", nil)
	req.Header.Set(protocol.HeaderPeer, "nOWNER")
	req.Header.Set(protocol.HeaderEdgeSecret, "attacker")
	h.ServeHTTP(httptest.NewRecorder(), req)

	// The handler mutates the inbound header in place; after the call it must be clean.
	if v := req.Header.Get(protocol.HeaderPeer); v != "" {
		t.Errorf("the inbound request still carries a forged peer: %q", v)
	}
	if v := req.Header.Get(protocol.HeaderEdgeSecret); v != "" {
		t.Errorf("the inbound request still carries a forged secret: %q", v)
	}
	if _, ok := seen.Load().(http.Header); !ok {
		t.Fatal("upstream was never reached")
	}
}

// TestProxyFunnelPeer: behind Funnel there is no identity, so the literal `funnel` is
// injected rather than nothing, and the server sees one shared bucket.
func TestProxyFunnelPeer(t *testing.T) {
	h, got := newTestProxy(t, staticPeer(protocol.FunnelPeer))

	req := httptest.NewRequest(http.MethodPost, "http://cast.example.com/api/v1/pair/claim", strings.NewReader("{}"))
	req.RemoteAddr = "203.0.113.9:41000"
	h.ServeHTTP(httptest.NewRecorder(), req)

	if v := got.header.Get(protocol.HeaderPeer); v != "funnel" {
		t.Errorf("%s = %q, want funnel", protocol.HeaderPeer, v)
	}
}

// TestProxyEmptyPeerFallsBackToFunnel: an empty identity must never be injected. The server
// keys its rate limiter on this header and an empty key is a free pass.
func TestProxyEmptyPeerFallsBackToFunnel(t *testing.T) {
	h, got := newTestProxy(t, staticPeer(""))

	req := httptest.NewRequest(http.MethodGet, "http://host/api/v1/me", nil)
	h.ServeHTTP(httptest.NewRecorder(), req)

	if v := got.header.Get(protocol.HeaderPeer); v != protocol.FunnelPeer {
		t.Errorf("%s = %q, want the funnel fallback", protocol.HeaderPeer, v)
	}
}

// TestProxyUpstreamDownReturnsTypedError: the PWA branches on the code, never on the prose
// (spec 8).
func TestProxyUpstreamDownReturnsTypedError(t *testing.T) {
	// Port 1 on loopback: reserved, never listening, refuses immediately.
	h, err := newProxyHandler("127.0.0.1:1", testSecret, staticPeer("nREAL"), nil)
	if err != nil {
		t.Fatalf("newProxyHandler: %v", err)
	}

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "http://host/api/v1/me", nil))

	if rec.Code != http.StatusServiceUnavailable {
		t.Errorf("status = %d, want 503", rec.Code)
	}
	var body protocol.APIError
	if err := json.NewDecoder(rec.Body).Decode(&body); err != nil {
		t.Fatalf("decode error body: %v", err)
	}
	if body.Error.Code != protocol.ErrCodeEdgeNotReady {
		t.Errorf("code = %q, want %q", body.Error.Code, protocol.ErrCodeEdgeNotReady)
	}
}

func TestNewProxyHandlerRejectsBadUpstream(t *testing.T) {
	for _, bad := range []string{"", "://", "http://127.0.0.1:8080"} {
		if _, err := newProxyHandler(bad, testSecret, staticPeer("x"), nil); err == nil {
			t.Errorf("upstream %q was accepted", bad)
		}
	}
}

// ─── peer resolution ─────────────────────────────────────────────────────────

func TestPeerIdentity(t *testing.T) {
	cases := []struct {
		name                       string
		stableID, nodeName, fallbk string
		want                       string
	}{
		{"stable id wins", "nABC", "phone.tail1234.ts.net.", "funnel", "nABC"},
		{"fqdn when there is no stable id", "", "phone.tail1234.ts.net.", "funnel", "phone.tail1234.ts.net"},
		{"trailing dot is stripped", "", "phone.tail1234.ts.net.", "funnel", "phone.tail1234.ts.net"},
		{"whitespace only counts as absent", "   ", "  ", "funnel", "funnel"},
		{"fallback when nothing is known", "", "", "funnel", "funnel"},
		{"fallback is used verbatim", "", "", "unknown", "unknown"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := peerIdentity(tc.stableID, tc.nodeName, tc.fallbk); got != tc.want {
				t.Errorf("peerIdentity(%q, %q, %q) = %q, want %q",
					tc.stableID, tc.nodeName, tc.fallbk, got, tc.want)
			}
		})
	}
}

type fakeWhoIs struct {
	calls atomic.Int32
	resp  *whoIsResponse
	err   error
}

func (f *fakeWhoIs) WhoIs(context.Context, string) (*whoIsResponse, error) {
	f.calls.Add(1)
	return f.resp, f.err
}

func TestWhoisResolver(t *testing.T) {
	clock := fixedClock()

	t.Run("resolves a node", func(t *testing.T) {
		f := &fakeWhoIs{resp: &whoIsResponse{Node: &whoIsNode{StableID: "nPHONE", Name: "phone.tail1234.ts.net."}}}
		r := newWhoisResolver(f, protocol.FunnelPeer, clock)
		if got := r.Peer(context.Background(), "100.64.0.7:52344"); got != "nPHONE" {
			t.Errorf("Peer = %q", got)
		}
	})

	t.Run("a WhoIs failure falls back rather than inventing an identity", func(t *testing.T) {
		f := &fakeWhoIs{err: errors.New("no such peer")}
		r := newWhoisResolver(f, protocol.FunnelPeer, clock)
		if got := r.Peer(context.Background(), "100.64.0.7:52344"); got != protocol.FunnelPeer {
			t.Errorf("Peer = %q, want the fallback", got)
		}
	})

	t.Run("a nil node falls back", func(t *testing.T) {
		f := &fakeWhoIs{resp: &whoIsResponse{}}
		r := newWhoisResolver(f, protocol.FunnelPeer, clock)
		if got := r.Peer(context.Background(), "100.64.0.7:52344"); got != protocol.FunnelPeer {
			t.Errorf("Peer = %q, want the fallback", got)
		}
	})

	t.Run("an empty remote address never reaches WhoIs", func(t *testing.T) {
		f := &fakeWhoIs{resp: &whoIsResponse{Node: &whoIsNode{StableID: "nPHONE"}}}
		r := newWhoisResolver(f, protocol.FunnelPeer, clock)
		if got := r.Peer(context.Background(), ""); got != protocol.FunnelPeer {
			t.Errorf("Peer = %q, want the fallback", got)
		}
		if f.calls.Load() != 0 {
			t.Error("WhoIs was called for an empty address")
		}
	})

	// Seeking a 4K file produces dozens of range requests a second from one peer; each must
	// not become a round trip to tailscaled.
	t.Run("caches per node, not per connection", func(t *testing.T) {
		f := &fakeWhoIs{resp: &whoIsResponse{Node: &whoIsNode{StableID: "nPHONE"}}}
		now := time.Now()
		r := newWhoisResolver(f, protocol.FunnelPeer, func() time.Time { return now })

		for i := 0; i < 50; i++ {
			// A different source port every time, as a real client would use.
			if got := r.Peer(context.Background(), "100.64.0.7:5000"); got != "nPHONE" {
				t.Fatalf("Peer = %q", got)
			}
		}
		if n := f.calls.Load(); n != 1 {
			t.Errorf("WhoIs was called %d times, want 1", n)
		}

		// After the TTL the identity is looked up again, so a revoked device is not cached
		// for ever.
		now = now.Add(peerCacheTTL + time.Second)
		if got := r.Peer(context.Background(), "100.64.0.7:5000"); got != "nPHONE" {
			t.Fatalf("Peer = %q", got)
		}
		if n := f.calls.Load(); n != 2 {
			t.Errorf("WhoIs was called %d times after the TTL, want 2", n)
		}
	})
}

// peerResolverFunc adapts a function to peerResolver.
type peerResolverFunc func(ctx context.Context, remoteAddr string) string

func (f peerResolverFunc) Peer(ctx context.Context, remoteAddr string) string {
	return f(ctx, remoteAddr)
}
