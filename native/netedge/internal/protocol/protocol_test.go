package protocol

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"
)

// TestEdgeStateStringsMatchContract pins the seven states, spelled exactly as
// packages/contract/src/netedge.ts spells them. If this test and that file ever disagree,
// one of them is wrong and the tray dot is the thing that breaks.
func TestEdgeStateStringsMatchContract(t *testing.T) {
	want := []string{
		"stopped",
		"starting",
		"login-required",
		"connecting",
		"obtaining-certificate",
		"connected",
		"error",
	}

	got := AllEdgeStates()
	if len(got) != len(want) {
		t.Fatalf("AllEdgeStates() has %d entries, contract has %d", len(got), len(want))
	}
	for i, w := range want {
		if string(got[i]) != w {
			t.Errorf("state %d = %q, contract says %q", i, got[i], w)
		}
	}

	for _, s := range got {
		if !s.Valid() {
			t.Errorf("%q is in AllEdgeStates but Valid() says no", s)
		}
	}
	if EdgeState("connected ").Valid() {
		t.Error("a state with a trailing space must not validate")
	}
	if EdgeState("Connected").Valid() {
		t.Error("state comparison must be case sensitive")
	}
}

// TestContractConstants pins the string literals shared with the TypeScript side.
func TestContractConstants(t *testing.T) {
	pairs := map[string]string{
		HeaderEdgeSecret:  "x-lc-edge-secret",
		HeaderPeer:        "x-lc-peer",
		FunnelPeer:        "funnel",
		RouteStatus:       "/edge/status",
		RouteStatusStream: "/edge/status/stream",
		RouteConfig:       "/edge/config",
		RouteTest:         "/edge/test",
		RouteLogin:        "/edge/login",
		RouteLogout:       "/edge/logout",
		RouteRestart:      "/edge/restart",
	}
	for got, want := range pairs {
		if got != want {
			t.Errorf("constant %q does not match contract %q", got, want)
		}
	}

	if ErrCodeEdgeModeUnsupported != "edge_mode_unsupported" {
		t.Errorf("EDGE_MODE_UNSUPPORTED wire value = %q", ErrCodeEdgeModeUnsupported)
	}
	if ErrCodeEdgeControlUnreachable != "edge_control_unreachable" {
		t.Errorf("EDGE_CONTROL_UNREACHABLE wire value = %q", ErrCodeEdgeControlUnreachable)
	}
}

func TestNetworkConfigJSON(t *testing.T) {
	cases := []struct {
		name string
		cfg  NetworkConfig
		want string
	}{
		{
			name: "default mode omits every optional field",
			cfg: NetworkConfig{
				Mode:         ModeDefault,
				Expose:       ExposeTailnet,
				CertStrategy: CertControlPlane,
				Hostname:     DefaultHostname,
			},
			want: `{"mode":"default","expose":"tailnet","certStrategy":"control-plane","hostname":"localcast"}`,
		},
		{
			name: "funnel",
			cfg: NetworkConfig{
				Mode:         ModeDefault,
				Expose:       ExposeFunnel,
				CertStrategy: CertControlPlane,
				Hostname:     "living-room",
			},
			want: `{"mode":"default","expose":"funnel","certStrategy":"control-plane","hostname":"living-room"}`,
		},
		{
			name: "custom mode with every field populated",
			cfg: NetworkConfig{
				Mode:         ModeCustom,
				ControlURL:   "https://hs.example.com",
				AuthKey:      "tskey-auth-secret",
				Expose:       ExposeTailnet,
				CertStrategy: CertDNS01,
				CertDomain:   "cast.example.com",
				DNSProvider:  DNSProviderCloudflare,
				DNSAPIToken:  "cf-token",
				Hostname:     DefaultHostname,
			},
			want: `{"mode":"custom","controlUrl":"https://hs.example.com","authKey":"tskey-auth-secret",` +
				`"expose":"tailnet","certStrategy":"dns01","certDomain":"cast.example.com",` +
				`"dnsProvider":"cloudflare","dnsApiToken":"cf-token","hostname":"localcast"}`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(tc.cfg)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(raw) != tc.want {
				t.Errorf("marshal\n got %s\nwant %s", raw, tc.want)
			}

			var back NetworkConfig
			if err := json.Unmarshal(raw, &back); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if !reflect.DeepEqual(back, tc.cfg) {
				t.Errorf("round trip\n got %#v\nwant %#v", back, tc.cfg)
			}
		})
	}
}

// TestEdgeStatusEmitsExplicitNulls guards the difference between zod's `.nullable()` (key
// required, value may be null) and `omitempty` (key dropped). Dropping the key makes the
// TypeScript parse fail.
func TestEdgeStatusEmitsExplicitNulls(t *testing.T) {
	raw, err := json.Marshal(EdgeStatus{State: StateStopped})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"state":"stopped","host":null,"funnelUrl":null,"loginUrl":null,` +
		`"errorCode":null,"errorMessage":null,"certExpiresAt":null,"peers":0,"updatedAt":0}`
	if string(raw) != want {
		t.Errorf("marshal\n got %s\nwant %s", raw, want)
	}

	full := EdgeStatus{
		State:         StateConnected,
		Host:          Ptr("localcast.tail1234.ts.net"),
		FunnelURL:     Ptr("https://localcast.tail1234.ts.net"),
		LoginURL:      nil,
		ErrorCode:     nil,
		ErrorMessage:  nil,
		CertExpiresAt: Ptr(int64(1788000000000)),
		Peers:         3,
		UpdatedAt:     1756684800000,
	}
	raw, err = json.Marshal(full)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var back EdgeStatus
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if !reflect.DeepEqual(back, full) {
		t.Errorf("round trip\n got %#v\nwant %#v", back, full)
	}
}

// TestEdgeTestResultMessagesNeverNull: zod types `messages` as a required array. A nil Go
// slice marshals to `null`, which fails the parse.
func TestEdgeTestResultMessagesNeverNull(t *testing.T) {
	raw, err := json.Marshal(NewEdgeTestResult())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	want := `{"ok":false,"controlReachable":false,"certificateViable":false,"messages":[],"loginUrl":null}`
	if string(raw) != want {
		t.Errorf("marshal\n got %s\nwant %s", raw, want)
	}

	// The zero value is the trap this test exists for.
	raw, err = json.Marshal(EdgeTestResult{})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if !strings.Contains(string(raw), `"messages":null`) {
		t.Fatal("expected the zero value to marshal messages as null; " +
			"if that changed, NewEdgeTestResult may no longer be necessary")
	}
}

func TestEdgeStdoutEventJSON(t *testing.T) {
	cases := []struct {
		name  string
		event EdgeStdoutEvent
		want  string
	}{
		{
			name:  "ready",
			event: ReadyEvent(45123),
			want:  `{"type":"ready","controlPort":45123}`,
		},
		{
			name:  "log",
			event: LogEvent(LogInfo, "listening on the tailnet"),
			want:  `{"type":"log","level":"info","message":"listening on the tailnet"}`,
		},
		{
			name:  "status",
			event: StatusEvent(EdgeStatus{State: StateStarting, UpdatedAt: 7}),
			want: `{"type":"status","status":{"state":"starting","host":null,"funnelUrl":null,` +
				`"loginUrl":null,"errorCode":null,"errorMessage":null,"certExpiresAt":null,` +
				`"peers":0,"updatedAt":7}}`,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			raw, err := json.Marshal(tc.event)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			if string(raw) != tc.want {
				t.Errorf("marshal\n got %s\nwant %s", raw, tc.want)
			}

			var back EdgeStdoutEvent
			if err := json.Unmarshal(raw, &back); err != nil {
				t.Fatalf("unmarshal: %v", err)
			}
			if !reflect.DeepEqual(back, tc.event) {
				t.Errorf("round trip\n got %#v\nwant %#v", back, tc.event)
			}
		})
	}
}

func TestApplyDefaults(t *testing.T) {
	c := NetworkConfig{Mode: ModeDefault, CertStrategy: CertControlPlane}
	c.ApplyDefaults()
	if c.Expose != ExposeTailnet {
		t.Errorf("expose default = %q, want tailnet", c.Expose)
	}
	if c.Hostname != DefaultHostname {
		t.Errorf("hostname default = %q, want %q", c.Hostname, DefaultHostname)
	}

	// Defaults must not overwrite a value the user chose.
	c = NetworkConfig{Expose: ExposeFunnel, Hostname: "study"}
	c.ApplyDefaults()
	if c.Expose != ExposeFunnel || c.Hostname != "study" {
		t.Errorf("ApplyDefaults overwrote explicit values: %+v", c.Redacted())
	}
}

func TestValidate(t *testing.T) {
	base := func(mut func(*NetworkConfig)) NetworkConfig {
		c := NetworkConfig{
			Mode:         ModeDefault,
			Expose:       ExposeTailnet,
			CertStrategy: CertControlPlane,
			Hostname:     DefaultHostname,
		}
		if mut != nil {
			mut(&c)
		}
		return c
	}

	cases := []struct {
		name      string
		cfg       NetworkConfig
		wantOK    bool
		wantField string
		wantCode  string
	}{
		{name: "default + control-plane", cfg: base(nil), wantOK: true},
		{
			name: "default + funnel",
			cfg: base(func(c *NetworkConfig) {
				c.Expose = ExposeFunnel
			}),
			wantOK: true,
		},
		{
			name: "default + external-proxy with a domain",
			cfg: base(func(c *NetworkConfig) {
				c.CertStrategy = CertExternalProxy
				c.CertDomain = "cast.example.com"
			}),
			wantOK: true,
		},
		{
			name: "external-proxy without a domain",
			cfg: base(func(c *NetworkConfig) {
				c.CertStrategy = CertExternalProxy
			}),
			wantField: "certDomain",
			wantCode:  ErrCodeBadRequest,
		},
		{
			name: "dns01 without a token",
			cfg: base(func(c *NetworkConfig) {
				c.CertStrategy = CertDNS01
				c.CertDomain = "cast.example.com"
				c.DNSProvider = DNSProviderCloudflare
			}),
			wantField: "certDomain",
			wantCode:  ErrCodeBadRequest,
		},
		{
			name: "dns01 complete",
			cfg: base(func(c *NetworkConfig) {
				c.CertStrategy = CertDNS01
				c.CertDomain = "cast.example.com"
				c.DNSProvider = DNSProviderRoute53
				c.DNSAPIToken = "AKIA...:secret"
			}),
			wantOK: true,
		},
		{
			name: "custom without a control URL",
			cfg: base(func(c *NetworkConfig) {
				c.Mode = ModeCustom
				c.CertStrategy = CertExternalProxy
				c.CertDomain = "cast.example.com"
			}),
			wantField: "controlUrl",
			wantCode:  ErrCodeBadRequest,
		},
		{
			name: "custom with a relative control URL",
			cfg: base(func(c *NetworkConfig) {
				c.Mode = ModeCustom
				c.ControlURL = "hs.example.com"
				c.CertStrategy = CertExternalProxy
				c.CertDomain = "cast.example.com"
			}),
			wantField: "controlUrl",
			wantCode:  ErrCodeBadRequest,
		},
		{
			name: "custom + control-plane is the impossible combination",
			cfg: base(func(c *NetworkConfig) {
				c.Mode = ModeCustom
				c.ControlURL = "https://hs.example.com"
			}),
			wantField: "certStrategy",
			wantCode:  ErrCodeEdgeModeUnsupported,
		},
		{
			name: "custom + funnel",
			cfg: base(func(c *NetworkConfig) {
				c.Mode = ModeCustom
				c.ControlURL = "https://hs.example.com"
				c.Expose = ExposeFunnel
				c.CertStrategy = CertExternalProxy
				c.CertDomain = "cast.example.com"
			}),
			wantField: "expose",
			wantCode:  ErrCodeEdgeModeUnsupported,
		},
		{
			name: "custom + external-proxy is allowed",
			cfg: base(func(c *NetworkConfig) {
				c.Mode = ModeCustom
				c.ControlURL = "https://hs.example.com"
				c.CertStrategy = CertExternalProxy
				c.CertDomain = "cast.example.com"
			}),
			wantOK: true,
		},
		{
			name: "custom + dns01 is allowed",
			cfg: base(func(c *NetworkConfig) {
				c.Mode = ModeCustom
				c.ControlURL = "https://hs.example.com"
				c.CertStrategy = CertDNS01
				c.CertDomain = "cast.example.com"
				c.DNSProvider = DNSProviderGandi
				c.DNSAPIToken = "gandi-token"
			}),
			wantOK: true,
		},
		{
			name: "a redacted auth key is refused",
			cfg: base(func(c *NetworkConfig) {
				c.Mode = ModeCustom
				c.ControlURL = "https://hs.example.com"
				c.AuthKey = RedactedPlaceholder
				c.CertStrategy = CertExternalProxy
				c.CertDomain = "cast.example.com"
			}),
			wantField: "authKey",
			wantCode:  ErrCodeBadRequest,
		},
		{
			name:      "unknown hostname",
			cfg:       base(func(c *NetworkConfig) { c.Hostname = "" }),
			wantField: "hostname",
			wantCode:  ErrCodeBadRequest,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.cfg.Validate()
			if tc.wantOK {
				if err != nil {
					t.Fatalf("want valid, got %v", err)
				}
				return
			}
			if err == nil {
				t.Fatal("want an error, got none")
			}
			var verrs ValidationErrors
			if !errors.As(err, &verrs) {
				t.Fatalf("error is %T, want ValidationErrors", err)
			}
			found := false
			for _, e := range verrs {
				if e.Field == tc.wantField && e.Code == tc.wantCode {
					found = true
				}
			}
			if !found {
				t.Errorf("no issue for field %q with code %q; got %v", tc.wantField, tc.wantCode, verrs)
			}
		})
	}
}

// TestRedaction is the log-path half of the "never log a secret" rule. The config package
// owns the disk half.
func TestRedaction(t *testing.T) {
	const authKey = "tskey-auth-kFbb9Vi7CNTRL-verySecretValue"
	const dnsToken = "cf_live_0123456789abcdef"

	cfg := NetworkConfig{
		Mode:         ModeCustom,
		ControlURL:   "https://hs.example.com",
		AuthKey:      authKey,
		Expose:       ExposeTailnet,
		CertStrategy: CertDNS01,
		CertDomain:   "cast.example.com",
		DNSProvider:  DNSProviderCloudflare,
		DNSAPIToken:  dnsToken,
		Hostname:     DefaultHostname,
	}

	for _, rendering := range []string{
		cfg.String(),
		// %v and %s both reach String because it is declared on the value type, so a
		// NetworkConfig embedded in a wrapped error cannot leak either. The pointer case is
		// included because a value method is in the pointer's method set too.
		fmt.Sprintf("%v", cfg),
		fmt.Sprintf("%s", cfg),
		fmt.Sprintf("%v", &cfg),
	} {
		if strings.Contains(rendering, authKey) {
			t.Errorf("auth key leaked into %q", rendering)
		}
		if strings.Contains(rendering, dnsToken) {
			t.Errorf("dns token leaked into %q", rendering)
		}
		if !strings.Contains(rendering, RedactedPlaceholder) {
			t.Errorf("no redaction marker in %q", rendering)
		}
	}

	red := cfg.Redacted()
	if red.AuthKey != RedactedPlaceholder || red.DNSAPIToken != RedactedPlaceholder {
		t.Errorf("Redacted() left a secret: %+v", red)
	}
	if red.ControlURL != cfg.ControlURL || red.CertDomain != cfg.CertDomain {
		t.Error("Redacted() must not touch non-secret fields")
	}
	if cfg.AuthKey != authKey {
		t.Error("Redacted() mutated the receiver")
	}

	bare := cfg.WithoutSecrets()
	if bare.AuthKey != "" || bare.DNSAPIToken != "" {
		t.Errorf("WithoutSecrets() left a secret: %+v", bare)
	}
	if bare.HasSecrets() {
		t.Error("HasSecrets() disagrees with WithoutSecrets()")
	}
	raw, err := json.Marshal(bare)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// WithoutSecrets, not Redacted, is what goes on the wire: the placeholder must not be
	// there for a settings page to read back and PUT again.
	if strings.Contains(string(raw), RedactedPlaceholder) ||
		strings.Contains(string(raw), authKey) ||
		strings.Contains(string(raw), dnsToken) {
		t.Errorf("WithoutSecrets marshalled to %s", raw)
	}

	// An empty secret must stay empty rather than becoming the placeholder, or HasSecrets
	// would start reporting true for a config that has none.
	empty := NetworkConfig{Mode: ModeDefault}.Redacted()
	if empty.AuthKey != "" || empty.DNSAPIToken != "" {
		t.Errorf("Redacted() invented a secret: %+v", empty)
	}
}
