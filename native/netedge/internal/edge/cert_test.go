package edge

import (
	"context"
	"strings"
	"testing"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

// TestNewCertProviderRefusesTheImpossiblePath is the third of the three layers that reject
// custom + control-plane. Validate stops it being saved and RunTest stops it being chosen;
// this stops it being constructed, so a configuration that arrived some other way still
// cannot produce a node that is up, reachable and unable to serve a single request.
func TestNewCertProviderRefusesTheImpossiblePath(t *testing.T) {
	cfg := protocol.NetworkConfig{
		Mode:         protocol.ModeCustom,
		ControlURL:   "https://hs.example.com",
		Expose:       protocol.ExposeTailnet,
		CertStrategy: protocol.CertControlPlane,
		Hostname:     protocol.DefaultHostname,
	}

	_, err := newCertProvider(cfg, certDeps{
		domain: func() string { return "cast.example.com" },
		// A certPair function is deliberately supplied: the refusal must come from the mode,
		// not from a missing collaborator.
		certPair: func(context.Context, string) ([]byte, []byte, error) { return nil, nil, nil },
	})
	if err == nil {
		t.Fatal("custom + control-plane was constructed")
	}
	if got := codeOf(err); got != protocol.ErrCodeEdgeModeUnsupported {
		t.Errorf("code = %q, want %q", got, protocol.ErrCodeEdgeModeUnsupported)
	}
}

func TestNewCertProviderControlPlaneNeedsALocalClient(t *testing.T) {
	cfg := protocol.NetworkConfig{
		Mode:         protocol.ModeDefault,
		Expose:       protocol.ExposeTailnet,
		CertStrategy: protocol.CertControlPlane,
		Hostname:     protocol.DefaultHostname,
	}

	if _, err := newCertProvider(cfg, certDeps{domain: func() string { return "x" }}); err == nil {
		t.Fatal("the control-plane strategy was constructed without a way to ask for a certificate")
	}
}

// TestExternalProxyServesPlainHTTP: a nil *tls.Config is the signal to serve plain HTTP. It
// must never be a self-signed certificate — design spec 8 says the server holds requests
// rather than teaching the user to click through a warning.
func TestExternalProxyServesPlainHTTP(t *testing.T) {
	cfg := protocol.NetworkConfig{
		Mode:         protocol.ModeCustom,
		ControlURL:   "https://hs.example.com",
		Expose:       protocol.ExposeTailnet,
		CertStrategy: protocol.CertExternalProxy,
		CertDomain:   "cast.example.com",
		Hostname:     protocol.DefaultHostname,
	}

	p, err := newCertProvider(cfg, certDeps{domain: func() string { return cfg.CertDomain }})
	if err != nil {
		t.Fatalf("newCertProvider: %v", err)
	}
	t.Cleanup(func() { _ = p.Close() })

	tlsCfg, err := p.TLSConfig(context.Background())
	if err != nil {
		t.Fatalf("TLSConfig: %v", err)
	}
	if tlsCfg != nil {
		t.Error("external-proxy must return a nil TLS config, not a certificate of its own")
	}
	if p.ExpiresAt() != nil {
		t.Error("external-proxy holds no certificate, so it must not report an expiry")
	}
}

func TestNewCertProviderRejectsIncompleteDNS01(t *testing.T) {
	base := protocol.NetworkConfig{
		Mode:         protocol.ModeDefault,
		Expose:       protocol.ExposeTailnet,
		CertStrategy: protocol.CertDNS01,
		CertDomain:   "cast.example.com",
		DNSProvider:  protocol.DNSProviderCloudflare,
		DNSAPIToken:  "cf-token",
		Hostname:     protocol.DefaultHostname,
	}

	for name, mut := range map[string]func(*protocol.NetworkConfig){
		"no domain":   func(c *protocol.NetworkConfig) { c.CertDomain = "" },
		"no provider": func(c *protocol.NetworkConfig) { c.DNSProvider = "" },
		"no token":    func(c *protocol.NetworkConfig) { c.DNSAPIToken = "" },
		"unknown provider": func(c *protocol.NetworkConfig) {
			c.DNSProvider = protocol.DNSProvider("namecheap")
		},
	} {
		t.Run(name, func(t *testing.T) {
			cfg := base
			mut(&cfg)
			p, err := newCertProvider(cfg, certDeps{domain: func() string { return cfg.CertDomain }})
			if err == nil {
				_ = p.Close()
				t.Fatal("an incomplete dns01 configuration was constructed")
			}
			if got := codeOf(err); got != protocol.ErrCodeBadRequest {
				t.Errorf("code = %q, want %q", got, protocol.ErrCodeBadRequest)
			}
		})
	}
}

// TestDNSSolverProviderRoute53Credential: Route 53 is the odd one out — it needs a key pair
// where every other provider takes a bearer token, so the single `dnsApiToken` field is read
// as "accessKeyId:secretAccessKey". A user who pastes a bare key must be told, not handed an
// opaque AWS error later.
func TestDNSSolverProviderRoute53Credential(t *testing.T) {
	if _, err := dnsSolverProvider(protocol.DNSProviderRoute53, "AKIAEXAMPLE:secret"); err != nil {
		t.Errorf("a well-formed Route 53 credential was refused: %v", err)
	}

	for _, bad := range []string{"AKIAEXAMPLE", ":secret", "AKIAEXAMPLE:", ""} {
		if _, err := dnsSolverProvider(protocol.DNSProviderRoute53, bad); err == nil {
			t.Errorf("Route 53 accepted %q", bad)
		}
	}
}

func TestDNSSolverProviderKnowsEveryContractProvider(t *testing.T) {
	// Every provider the contract's dnsProviderSchema names must be constructible, or the
	// settings page would offer a choice that fails at save time.
	for _, p := range []protocol.DNSProvider{
		protocol.DNSProviderCloudflare,
		protocol.DNSProviderDigitalOcean,
		protocol.DNSProviderGandi,
	} {
		if _, err := dnsSolverProvider(p, "token"); err != nil {
			t.Errorf("%s: %v", p, err)
		}
	}
	if _, err := dnsSolverProvider(protocol.DNSProviderRoute53, "id:secret"); err != nil {
		t.Errorf("route53: %v", err)
	}
	if _, err := dnsSolverProvider(protocol.DNSProvider("namecheap"), "token"); err == nil {
		t.Error("an unsupported provider was accepted")
	}
}

func TestCertDomainFor(t *testing.T) {
	cases := []struct {
		name string
		cfg  protocol.NetworkConfig
		host string
		want string
	}{
		{
			name: "control-plane signs the MagicDNS name",
			cfg:  protocol.NetworkConfig{CertStrategy: protocol.CertControlPlane, CertDomain: "ignored.example.com"},
			host: "localcast.tail1234.ts.net",
			want: "localcast.tail1234.ts.net",
		},
		{
			name: "dns01 uses the domain the user owns",
			cfg:  protocol.NetworkConfig{CertStrategy: protocol.CertDNS01, CertDomain: "cast.example.com"},
			host: "localcast.headscale.example.com",
			want: "cast.example.com",
		},
		{
			name: "falling back to the host when no domain is configured",
			cfg:  protocol.NetworkConfig{CertStrategy: protocol.CertExternalProxy},
			host: "localcast.tail1234.ts.net",
			want: "localcast.tail1234.ts.net",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := certDomainFor(tc.cfg, tc.host); got != tc.want {
				t.Errorf("certDomainFor = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestSanitizeDirKey(t *testing.T) {
	cases := map[string]string{
		"https://hs.example.com":       "hs.example.com",
		"http://hs.example.com:8080":   "hs.example.com_8080",
		"https://HS.Example.COM/path/": "hs.example.com_path",
		"https://":                     "unnamed",
		"":                             "unnamed",
	}
	for in, want := range cases {
		if got := sanitizeDirKey(in); got != want {
			t.Errorf("sanitizeDirKey(%q) = %q, want %q", in, got, want)
		}
	}

	// A long URL must not produce a path component Windows refuses to create.
	long := "https://" + strings.Repeat("a", 300) + ".example.com"
	if got := sanitizeDirKey(long); len(got) > 64 {
		t.Errorf("sanitizeDirKey produced a %d-character component", len(got))
	}
}
