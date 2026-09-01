package edge

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/caddyserver/certmagic"
	"github.com/libdns/cloudflare"
	"github.com/libdns/digitalocean"
	"github.com/libdns/gandi"
	"github.com/libdns/route53"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

const (
	// certRenewBefore is how long before expiry the control-plane provider stops trusting
	// its cached copy and asks the daemon again. tailscaled renews well ahead of this; the
	// window only decides when we notice.
	certRenewBefore = 24 * time.Hour

	// dns01Timeout bounds the first DNS-01 issuance. Propagation is the slow part and it is
	// measured in minutes on some providers, so this is generous on purpose — but it is
	// bounded, because an unbounded wait would leave the UI in obtaining-certificate for
	// ever with nothing to tell the user.
	dns01Timeout = 10 * time.Minute
)

// certProvider supplies the TLS configuration for the tailnet listener.
type certProvider interface {
	// TLSConfig returns the configuration to wrap the listener with, or nil when the
	// strategy deliberately serves plain HTTP and trusts a fronting proxy.
	TLSConfig(ctx context.Context) (*tls.Config, error)

	// ExpiresAt reports the current leaf's NotAfter in Unix milliseconds, or nil when this
	// strategy does not hold a certificate of its own.
	ExpiresAt() *int64

	Close() error
}

// certPairFunc is LocalClient.CertPair: it asks the local Tailscale daemon for a
// certificate that the control plane obtained through its ACME delegation.
type certPairFunc func(ctx context.Context, domain string) (certPEM, keyPEM []byte, err error)

// certDeps are the collaborators a provider needs, injected so nothing here reaches for a
// package-level singleton.
type certDeps struct {
	// certPair is nil in custom mode. It must be: Headscale does not implement
	// /machine/set-dns, so asking it for a certificate cannot work and the code path must
	// not exist rather than merely not be taken (design spec 2.3).
	certPair certPairFunc

	// domain resolves the name to serve. It is a function because the MagicDNS name is only
	// known once the node is Running, which is after the provider is constructed.
	domain func() string

	cacheDir string
	logf     logFunc
	now      func() time.Time
}

// newCertProvider picks the strategy.
//
// The custom + control-plane combination is refused here as well as in Validate and in the
// dry run. Three checks for one rule is deliberate: this is the one configuration that
// silently produces a node which is up, reachable and unable to serve a single HTTPS
// request, and each layer catches it at a different moment.
func newCertProvider(cfg protocol.NetworkConfig, deps certDeps) (certProvider, error) {
	if deps.now == nil {
		deps.now = time.Now
	}
	if deps.logf == nil {
		deps.logf = func(protocol.LogLevel, string, ...any) {}
	}

	switch cfg.CertStrategy {
	case protocol.CertControlPlane:
		if cfg.Mode != protocol.ModeDefault {
			return nil, &edgeError{
				code: protocol.ErrCodeEdgeModeUnsupported,
				msg: "control-plane certificates need Tailscale's coordination server; " +
					"Headscale does not implement /machine/set-dns",
			}
		}
		if deps.certPair == nil {
			return nil, &edgeError{
				code: protocol.ErrCodeInternal,
				msg:  "control-plane strategy selected without a local Tailscale client",
			}
		}
		return &controlPlaneProvider{
			certPair: deps.certPair,
			domain:   deps.domain,
			now:      deps.now,
			logf:     deps.logf,
		}, nil

	case protocol.CertExternalProxy:
		return &externalProxyProvider{logf: deps.logf, domain: cfg.CertDomain}, nil

	case protocol.CertDNS01:
		// Construction only wires certmagic up; the network work happens in TLSConfig,
		// which is where the caller has a context and has already published
		// obtaining-certificate.
		//
		// Unpacked rather than `return newDNS01Provider(...)` so a failure returns a nil
		// interface: returning a typed nil pointer inside a certProvider would make
		// `provider != nil` true for a provider that does not exist.
		p, err := newDNS01Provider(cfg, deps)
		if err != nil {
			return nil, err
		}
		return p, nil

	default:
		return nil, &edgeError{
			code: protocol.ErrCodeBadRequest,
			msg:  fmt.Sprintf("unknown certificate strategy %q", cfg.CertStrategy),
		}
	}
}

// ─── control-plane ───────────────────────────────────────────────────────────

// controlPlaneProvider gets its certificate from the local Tailscale daemon, which got it
// from Tailscale's ACME delegation. Nothing is asked of the user and no DNS credential
// exists anywhere in this path.
type controlPlaneProvider struct {
	certPair certPairFunc
	domain   func() string
	now      func() time.Time
	logf     logFunc

	mu     sync.Mutex
	cur    *tls.Certificate
	expiry *int64
}

func (p *controlPlaneProvider) TLSConfig(context.Context) (*tls.Config, error) {
	return &tls.Config{
		MinVersion:     tls.VersionTLS12,
		NextProtos:     []string{"h2", "http/1.1"},
		GetCertificate: p.getCertificate,
	}, nil
}

// getCertificate is called per handshake. It serves from cache until the leaf is close to
// expiry, so an idle-but-connected node is not making a local API call for every TLS
// handshake a browser opens.
func (p *controlPlaneProvider) getCertificate(hi *tls.ClientHelloInfo) (*tls.Certificate, error) {
	name := strings.TrimSuffix(strings.ToLower(hi.ServerName), ".")
	if name == "" {
		// A client that connects by IP sends no SNI. There is exactly one name this node
		// serves, so use it rather than failing the handshake.
		name = strings.TrimSuffix(strings.ToLower(p.currentDomain()), ".")
	}
	if name == "" {
		return nil, &edgeError{
			code: protocol.ErrCodeEdgeCertUnavailable,
			msg:  "no MagicDNS name is known yet, so no certificate can be selected",
		}
	}

	p.mu.Lock()
	cached := p.cur
	p.mu.Unlock()
	if cached != nil && p.stillFresh(cached) && certMatches(cached, name) {
		return cached, nil
	}

	ctx := hi.Context()
	certPEM, keyPEM, err := p.certPair(ctx, name)
	if err != nil {
		// The usual cause is a tailnet with HTTPS certificates switched off in the admin
		// console. Saying so is more use than repeating the daemon's error.
		return nil, &edgeError{
			code: protocol.ErrCodeEdgeCertUnavailable,
			msg: fmt.Sprintf("the Tailscale control plane did not issue a certificate for %s "+
				"(is HTTPS enabled for this tailnet?): %v", name, err),
		}
	}

	pair, err := tls.X509KeyPair(certPEM, keyPEM)
	if err != nil {
		return nil, fmt.Errorf("parse control-plane certificate for %s: %w", name, err)
	}
	if leaf, err := x509.ParseCertificate(pair.Certificate[0]); err == nil {
		pair.Leaf = leaf
	}

	p.mu.Lock()
	p.cur = &pair
	if pair.Leaf != nil {
		p.expiry = protocol.Ptr(pair.Leaf.NotAfter.UnixMilli())
	}
	p.mu.Unlock()

	p.logf(protocol.LogInfo, "obtained a control-plane certificate for %s", name)
	return &pair, nil
}

func (p *controlPlaneProvider) currentDomain() string {
	if p.domain == nil {
		return ""
	}
	return p.domain()
}

func (p *controlPlaneProvider) stillFresh(c *tls.Certificate) bool {
	if c.Leaf == nil {
		return false
	}
	return p.now().Add(certRenewBefore).Before(c.Leaf.NotAfter)
}

func (p *controlPlaneProvider) ExpiresAt() *int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.expiry
}

func (p *controlPlaneProvider) Close() error { return nil }

// certMatches reports whether the cached certificate covers name. A tailnet node's name
// changes when the mode changes, and serving the previous tailnet's certificate would fail
// in the client with an unhelpful name-mismatch error.
func certMatches(c *tls.Certificate, name string) bool {
	if c.Leaf == nil {
		return false
	}
	return c.Leaf.VerifyHostname(name) == nil
}

// ─── external proxy ──────────────────────────────────────────────────────────

// externalProxyProvider serves plain HTTP and trusts the operator's Caddy/Traefik/nginx to
// terminate TLS in front of the node.
//
// TLSConfig returns nil, not a self-signed certificate. Design spec 8 is explicit that the
// server holds requests rather than falling back to self-signed: a browser that is taught to
// click through a certificate warning for LocalCast has been taught to click through them.
type externalProxyProvider struct {
	domain string
	logf   logFunc
}

func (p *externalProxyProvider) TLSConfig(context.Context) (*tls.Config, error) {
	p.logf(protocol.LogWarn,
		"serving plain HTTP on the tailnet address; %s must be terminated by your own proxy", p.domain)
	return nil, nil
}

// ExpiresAt is nil because this process holds no certificate. The settings page shows
// "managed by your proxy" rather than an expiry date it would be making up.
func (p *externalProxyProvider) ExpiresAt() *int64 { return nil }

func (p *externalProxyProvider) Close() error { return nil }

// ─── DNS-01 ──────────────────────────────────────────────────────────────────

// dns01Provider runs an ACME client against a domain the user owns, proving control through
// a DNS TXT record. This is the strategy that makes a personal Headscale usable with a real
// certificate, since the control plane cannot supply one.
type dns01Provider struct {
	magic  *certmagic.Config
	cache  *certmagic.Cache
	domain string
	logf   logFunc

	mu     sync.Mutex
	expiry *int64
}

func newDNS01Provider(cfg protocol.NetworkConfig, deps certDeps) (*dns01Provider, error) {
	if cfg.CertDomain == "" || cfg.DNSProvider == "" || cfg.DNSAPIToken == "" {
		return nil, &edgeError{
			code: protocol.ErrCodeBadRequest,
			msg:  "dns01 needs a domain, a provider and an API token",
		}
	}

	solverProvider, err := dnsSolverProvider(cfg.DNSProvider, cfg.DNSAPIToken)
	if err != nil {
		return nil, err
	}

	// Certificates are cached on disk and reused across restarts. Without this, every
	// restart would be a fresh issuance and Let's Encrypt's rate limits would lock the user
	// out after a handful of them.
	storage := &certmagic.FileStorage{Path: filepath.Join(deps.cacheDir, "acme")}

	var magic *certmagic.Config
	cache := certmagic.NewCache(certmagic.CacheOptions{
		GetConfigForCert: func(certmagic.Certificate) (*certmagic.Config, error) {
			return magic, nil
		},
	})
	magic = certmagic.New(cache, certmagic.Config{
		Storage: storage,
		// VERIFY: recent certmagic versions require a non-nil *zap.Logger on Config or they
		// fall back to certmagic.Default.Logger. If this build panics on a nil logger, set
		// Logger here (and add go.uber.org/zap to go.mod).
	})

	// VERIFY: two things in this call. The DNS01Solver shape changed around certmagic v0.21
	// — older releases took the provider directly as a DNSProvider field, newer ones nest it
	// under a DNSManager; this is written against the newer shape. And the constructor was
	// called NewACMEManager before it was called NewACMEIssuer.
	issuer := certmagic.NewACMEIssuer(magic, certmagic.ACMEIssuer{
		CA:     certmagic.LetsEncryptProductionCA,
		Agreed: true,
		DNS01Solver: &certmagic.DNS01Solver{
			DNSManager: certmagic.DNSManager{
				DNSProvider: solverProvider,
			},
		},
	})
	magic.Issuers = []certmagic.Issuer{issuer}

	return &dns01Provider{
		magic:  magic,
		cache:  cache,
		domain: cfg.CertDomain,
		logf:   deps.logf,
	}, nil
}

// TLSConfig obtains the certificate before returning.
//
// ManageSync rather than ManageAsync on purpose: the caller has already published the
// obtaining-certificate state, and blocking here means a DNS credential that is wrong fails
// now, visibly, instead of turning into a stream of failed TLS handshakes that the phone
// reports as "cannot connect to server".
func (p *dns01Provider) TLSConfig(ctx context.Context) (*tls.Config, error) {
	issueCtx, cancel := context.WithTimeout(ctx, dns01Timeout)
	defer cancel()

	p.logf(protocol.LogInfo, "obtaining an ACME certificate for %s over DNS-01", p.domain)
	if err := p.magic.ManageSync(issueCtx, []string{p.domain}); err != nil {
		return nil, &edgeError{
			code: protocol.ErrCodeEdgeCertUnavailable,
			msg:  fmt.Sprintf("DNS-01 issuance for %s failed: %v", p.domain, err),
			err:  err,
		}
	}
	p.refreshExpiry(ctx)
	p.logf(protocol.LogInfo, "certificate for %s is in place; renewal is automatic", p.domain)

	return &tls.Config{
		MinVersion:     tls.VersionTLS12,
		NextProtos:     []string{"h2", "http/1.1"},
		GetCertificate: p.magic.GetCertificate,
	}, nil
}

// refreshExpiry is best effort: an expiry we cannot read is a missing badge in the settings
// page, not a reason to refuse to serve.
func (p *dns01Provider) refreshExpiry(ctx context.Context) {
	// VERIFY: CacheManagedCertificate's signature has been
	// (ctx, domain) (Certificate, error) in recent certmagic; older releases omitted ctx.
	cert, err := p.magic.CacheManagedCertificate(ctx, p.domain)
	if err != nil || cert.Leaf == nil {
		return
	}
	p.mu.Lock()
	p.expiry = protocol.Ptr(cert.Leaf.NotAfter.UnixMilli())
	p.mu.Unlock()
}

func (p *dns01Provider) ExpiresAt() *int64 {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.expiry
}

// Close stops the renewal goroutines certmagic started. Without it, restarting in place
// would leak one maintenance loop per mode switch.
func (p *dns01Provider) Close() error {
	if p.cache != nil {
		p.cache.Stop()
	}
	return nil
}

// dnsSolverProvider builds the libdns provider for the chosen DNS API.
//
// Every provider except Route 53 authenticates with a single bearer token, which is what the
// contract's `dnsApiToken` carries. Route 53 needs an access key pair, so the token is
// interpreted as "accessKeyId:secretAccessKey" — documented in the README, because a user
// pasting a bare key there would otherwise get an opaque AWS error.
//
// VERIFY: certmagic.DNSProvider is the interface a solver takes (libdns RecordAppender +
// RecordDeleter). If the name differs in the resolved version, this return type is the only
// place to change.
func dnsSolverProvider(name protocol.DNSProvider, token string) (certmagic.DNSProvider, error) {
	switch name {
	case protocol.DNSProviderCloudflare:
		// VERIFY: field name on github.com/libdns/cloudflare.Provider.
		return &cloudflare.Provider{APIToken: token}, nil

	case protocol.DNSProviderDigitalOcean:
		// VERIFY: field name on github.com/libdns/digitalocean.Provider.
		return &digitalocean.Provider{APIToken: token}, nil

	case protocol.DNSProviderGandi:
		// VERIFY: Gandi moved from an API key to a personal access token and the libdns
		// field was renamed with it (APIToken vs BearerToken, depending on the release).
		return &gandi.Provider{APIToken: token}, nil

	case protocol.DNSProviderRoute53:
		id, secret, ok := strings.Cut(token, ":")
		if !ok || id == "" || secret == "" {
			return nil, &edgeError{
				code: protocol.ErrCodeBadRequest,
				msg:  "route53 expects the credential as accessKeyId:secretAccessKey",
			}
		}
		// VERIFY: field names on github.com/libdns/route53.Provider.
		return &route53.Provider{AccessKeyId: id, SecretAccessKey: secret}, nil

	default:
		return nil, &edgeError{
			code: protocol.ErrCodeBadRequest,
			msg:  fmt.Sprintf("unsupported DNS provider %q", name),
		}
	}
}
