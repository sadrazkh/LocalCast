package edge

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

// cfgFor builds a configuration for one cell of the mode × strategy matrix, filled in with
// whatever that combination requires.
func cfgFor(mode protocol.NetworkMode, strategy protocol.CertStrategy, expose protocol.Expose) protocol.NetworkConfig {
	c := protocol.NetworkConfig{
		Mode:         mode,
		Expose:       expose,
		CertStrategy: strategy,
		Hostname:     protocol.DefaultHostname,
	}
	if mode == protocol.ModeCustom {
		c.ControlURL = "https://hs.example.com"
		c.AuthKey = "tskey-auth-notARealKey"
	}
	switch strategy {
	case protocol.CertExternalProxy:
		c.CertDomain = "cast.example.com"
	case protocol.CertDNS01:
		c.CertDomain = "cast.example.com"
		c.DNSProvider = protocol.DNSProviderCloudflare
		c.DNSAPIToken = "cf-token"
	}
	return c
}

// TestCertificateViabilityMatrix is the whole point of POST /edge/test: a configuration that
// cannot work must be rejected while the user is still looking at the form, not become a
// permanent "connecting…" spinner.
func TestCertificateViabilityMatrix(t *testing.T) {
	const (
		def     = protocol.ModeDefault
		custom  = protocol.ModeCustom
		cplane  = protocol.CertControlPlane
		xproxy  = protocol.CertExternalProxy
		dns01   = protocol.CertDNS01
		tailnet = protocol.ExposeTailnet
		funnel  = protocol.ExposeFunnel
	)

	cases := []struct {
		name       string
		cfg        protocol.NetworkConfig
		wantViable bool
		wantError  bool
		// wantText is a substring the message must name, so the user is told the actual
		// reason rather than "not supported".
		wantText string
	}{
		{
			name:       "default + control-plane is the zero-input path",
			cfg:        cfgFor(def, cplane, tailnet),
			wantViable: true,
		},
		{
			name:       "default + external-proxy",
			cfg:        cfgFor(def, xproxy, tailnet),
			wantViable: true,
			wantText:   "plain HTTP",
		},
		{
			name:       "default + dns01",
			cfg:        cfgFor(def, dns01, tailnet),
			wantViable: true,
			wantText:   "DNS-01",
		},
		{
			name:       "custom + control-plane cannot work and must say why",
			cfg:        cfgFor(custom, cplane, tailnet),
			wantViable: false,
			wantError:  true,
			wantText:   "/machine/set-dns",
		},
		{
			name:       "custom + external-proxy",
			cfg:        cfgFor(custom, xproxy, tailnet),
			wantViable: true,
		},
		{
			name:       "custom + dns01",
			cfg:        cfgFor(custom, dns01, tailnet),
			wantViable: true,
		},
		{
			name:       "default + funnel",
			cfg:        cfgFor(def, cplane, funnel),
			wantViable: true,
			wantText:   "Funnel terminates TLS",
		},
		{
			name:       "custom + funnel is refused whatever the strategy",
			cfg:        cfgFor(custom, xproxy, funnel),
			wantViable: false,
			wantError:  true,
			wantText:   "Funnel is a Tailscale service",
		},
		{
			name:       "custom + funnel + dns01 is still refused",
			cfg:        cfgFor(custom, dns01, funnel),
			wantViable: false,
			wantError:  true,
			wantText:   "headscale#1040",
		},
		{
			name: "external-proxy without a domain",
			cfg: func() protocol.NetworkConfig {
				c := cfgFor(def, xproxy, tailnet)
				c.CertDomain = ""
				return c
			}(),
			wantViable: false,
			wantError:  true,
			wantText:   "domain",
		},
		{
			name: "dns01 without a token",
			cfg: func() protocol.NetworkConfig {
				c := cfgFor(def, dns01, tailnet)
				c.DNSAPIToken = ""
				return c
			}(),
			wantViable: false,
			wantError:  true,
			wantText:   "API token",
		},
		{
			name: "dns01 with an unsupported provider",
			cfg: func() protocol.NetworkConfig {
				c := cfgFor(def, dns01, tailnet)
				c.DNSProvider = protocol.DNSProvider("namecheap")
				return c
			}(),
			wantViable: false,
			wantError:  true,
			wantText:   "namecheap",
		},
		{
			name: "an unknown strategy",
			cfg: func() protocol.NetworkConfig {
				c := cfgFor(def, cplane, tailnet)
				c.CertStrategy = protocol.CertStrategy("acme-magic")
				return c
			}(),
			wantViable: false,
			wantError:  true,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			viable, msgs := certificateViability(tc.cfg)

			if viable != tc.wantViable {
				t.Errorf("certificateViable = %v, want %v (messages: %s)", viable, tc.wantViable, joinTexts(msgs))
			}
			if got := hasLevel(msgs, protocol.MessageError); got != tc.wantError {
				t.Errorf("error-level message = %v, want %v (messages: %s)", got, tc.wantError, joinTexts(msgs))
			}
			if len(msgs) == 0 {
				t.Error("a viability decision with no explanation is useless to the user")
			}
			if tc.wantText != "" && !strings.Contains(joinTexts(msgs), tc.wantText) {
				t.Errorf("no message mentions %q; got: %s", tc.wantText, joinTexts(msgs))
			}
		})
	}
}

// TestCustomControlPlaneNamesTheIssue: the message has to be actionable. Naming the missing
// endpoint and the tracking issue is the difference between a user who changes the strategy
// and a user who files a bug against LocalCast.
func TestCustomControlPlaneNamesTheIssue(t *testing.T) {
	_, msgs := certificateViability(cfgFor(protocol.ModeCustom, protocol.CertControlPlane, protocol.ExposeTailnet))
	text := joinTexts(msgs)

	for _, want := range []string{
		"/machine/set-dns",
		"headscale#2527",
		"external-proxy",
		"dns01",
		protocol.ErrCodeEdgeModeUnsupported,
	} {
		if !strings.Contains(text, want) {
			t.Errorf("the refusal does not mention %q: %s", want, text)
		}
	}
}

func TestRunTestControlReachable(t *testing.T) {
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/key") {
			t.Errorf("probed %q, want the /key endpoint", r.URL.Path)
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"publicKey":"nlpub:deadbeef"}`))
	}))
	defer control.Close()

	t.Run("default mode, everything sound", func(t *testing.T) {
		res := RunTest(context.Background(),
			cfgFor(protocol.ModeDefault, protocol.CertControlPlane, protocol.ExposeTailnet),
			TestDeps{DefaultControlURL: control.URL})

		if !res.ControlReachable {
			t.Errorf("controlReachable = false: %s", joinTexts(res.Messages))
		}
		if !res.CertificateViable {
			t.Errorf("certificateViable = false: %s", joinTexts(res.Messages))
		}
		if !res.Ok {
			t.Errorf("ok = false: %s", joinTexts(res.Messages))
		}
		if res.LoginURL != nil {
			t.Errorf("a dry run must not register a node to obtain a login URL, got %q", *res.LoginURL)
		}
	})

	t.Run("custom mode with a reachable Headscale", func(t *testing.T) {
		cfg := cfgFor(protocol.ModeCustom, protocol.CertDNS01, protocol.ExposeTailnet)
		cfg.ControlURL = control.URL

		res := RunTest(context.Background(), cfg, TestDeps{})

		if !res.ControlReachable {
			t.Errorf("controlReachable = false: %s", joinTexts(res.Messages))
		}
		if !res.Ok {
			t.Errorf("ok = false: %s", joinTexts(res.Messages))
		}
	})

	// A control server that is reachable does not rescue an unusable certificate strategy:
	// the two are decided independently and ok is the conjunction.
	t.Run("reachable control plus an impossible strategy is still not ok", func(t *testing.T) {
		cfg := cfgFor(protocol.ModeCustom, protocol.CertControlPlane, protocol.ExposeTailnet)
		cfg.ControlURL = control.URL

		res := RunTest(context.Background(), cfg, TestDeps{})

		if !res.ControlReachable {
			t.Error("controlReachable should still be true; the server answered")
		}
		if res.CertificateViable {
			t.Error("certificateViable must be false for custom + control-plane")
		}
		if res.Ok {
			t.Error("ok must be false when the certificate cannot be issued")
		}
	})
}

func TestRunTestControlUnreachable(t *testing.T) {
	// A server that is closed before use: connecting to it fails immediately and
	// deterministically, with no timeout to wait out.
	control := httptest.NewServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	addr := control.URL
	control.Close()

	cfg := cfgFor(protocol.ModeCustom, protocol.CertExternalProxy, protocol.ExposeTailnet)
	cfg.ControlURL = addr

	res := RunTest(context.Background(), cfg, TestDeps{})

	if res.ControlReachable {
		t.Error("controlReachable must be false when nothing answered")
	}
	if res.Ok {
		t.Error("ok must be false when the control server is unreachable")
	}
	if !res.HasError() {
		t.Errorf("an unreachable control server must produce an error-level message: %s", joinTexts(res.Messages))
	}
	if !strings.Contains(joinTexts(res.Messages), protocol.ErrCodeEdgeControlUnreachable) {
		t.Errorf("the message must carry the machine code: %s", joinTexts(res.Messages))
	}
	// The strategy itself was fine; the result must not muddle the two reasons.
	if !res.CertificateViable {
		t.Errorf("certificateViable must not be dragged down by reachability: %s", joinTexts(res.Messages))
	}
}

func TestRunTestWarnsAboutPlainHTTPControlURL(t *testing.T) {
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer control.Close()

	cfg := cfgFor(protocol.ModeCustom, protocol.CertExternalProxy, protocol.ExposeTailnet)
	cfg.ControlURL = control.URL // httptest serves plain HTTP

	res := RunTest(context.Background(), cfg, TestDeps{})

	if !strings.Contains(joinTexts(res.Messages), "unencrypted") {
		t.Errorf("a plain-HTTP control URL must be flagged; the auth key travels to it: %s",
			joinTexts(res.Messages))
	}
	// A warning is not a refusal: some users run Headscale over a private link.
	if res.HasError() {
		t.Errorf("plain HTTP must warn, not refuse: %s", joinTexts(res.Messages))
	}
}

func TestRunTestReportsANonControlServer(t *testing.T) {
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "not found", http.StatusNotFound)
	}))
	defer control.Close()

	cfg := cfgFor(protocol.ModeCustom, protocol.CertExternalProxy, protocol.ExposeTailnet)
	cfg.ControlURL = control.URL

	res := RunTest(context.Background(), cfg, TestDeps{})

	if !res.ControlReachable {
		t.Error("something answered, so the address is reachable")
	}
	if !strings.Contains(joinTexts(res.Messages), "HTTP 404") {
		t.Errorf("a 404 from the key endpoint must be reported with its status: %s", joinTexts(res.Messages))
	}
	if !hasLevel(res.Messages, protocol.MessageWarn) {
		t.Errorf("a 404 from the key endpoint deserves a warning: %s", joinTexts(res.Messages))
	}
}

func TestRunTestMissingControlURL(t *testing.T) {
	cfg := cfgFor(protocol.ModeCustom, protocol.CertExternalProxy, protocol.ExposeTailnet)
	cfg.ControlURL = ""

	res := RunTest(context.Background(), cfg, TestDeps{})

	if res.ControlReachable {
		t.Error("reachability must not be claimed for an address that was never probed")
	}
	if !res.HasError() {
		t.Errorf("a missing control URL must be an error: %s", joinTexts(res.Messages))
	}
	if res.Ok {
		t.Error("ok must be false")
	}
}

// TestRunTestResultIsSerialisable guards the shape the settings page parses.
func TestRunTestResultIsSerialisable(t *testing.T) {
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer control.Close()

	res := RunTest(context.Background(),
		cfgFor(protocol.ModeDefault, protocol.CertControlPlane, protocol.ExposeTailnet),
		TestDeps{DefaultControlURL: control.URL})

	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if strings.Contains(string(raw), `"messages":null`) {
		t.Errorf("messages must be an array, not null: %s", raw)
	}
	if !strings.Contains(string(raw), `"loginUrl":null`) {
		t.Errorf("loginUrl must be present as null: %s", raw)
	}
}

// TestRunTestNeverEchoesSecrets: the result is rendered in a settings page and may end up in
// a support log.
func TestRunTestNeverEchoesSecrets(t *testing.T) {
	control := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer control.Close()

	const authKey = "tskey-auth-VERYSECRET"
	const dnsToken = "cf_live_VERYSECRET"

	cfg := cfgFor(protocol.ModeCustom, protocol.CertDNS01, protocol.ExposeTailnet)
	cfg.ControlURL = control.URL
	cfg.AuthKey = authKey
	cfg.DNSAPIToken = dnsToken

	res := RunTest(context.Background(), cfg, TestDeps{})
	text := joinTexts(res.Messages)

	if strings.Contains(text, authKey) {
		t.Errorf("the auth key was echoed back: %s", text)
	}
	if strings.Contains(text, dnsToken) {
		t.Errorf("the DNS token was echoed back: %s", text)
	}
}

func TestPlausibleHostname(t *testing.T) {
	cases := map[string]bool{
		"localcast":     true,
		"living-room":   true,
		"pc2":           true,
		"":              false,
		"-leading":      false,
		"trailing-":     false,
		"Ali's PC":      false,
		"has space":     false,
		"under_score":   false,
		"dotted.name":   false,
		strings.Repeat("a", 63): true,
		strings.Repeat("a", 64): false,
	}
	for in, want := range cases {
		if got := plausibleHostname(in); got != want {
			t.Errorf("plausibleHostname(%q) = %v, want %v", in, got, want)
		}
	}
}

func hasLevel(msgs []protocol.TestMessage, level protocol.MessageLevel) bool {
	for _, m := range msgs {
		if m.Level == level {
			return true
		}
	}
	return false
}

func joinTexts(msgs []protocol.TestMessage) string {
	parts := make([]string, 0, len(msgs))
	for _, m := range msgs {
		parts = append(parts, string(m.Level)+": "+m.Text)
	}
	return strings.Join(parts, " | ")
}
