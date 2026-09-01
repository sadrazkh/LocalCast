// Package protocol mirrors packages/contract/src/netedge.ts.
//
// That file and this one are the only place TypeScript and Go meet. Every JSON tag here is
// spelled exactly as the zod schema spells it, because a mismatch would not fail any build:
// it would produce a status object that Electron parses into `undefined`, and the only
// symptom would be a tray icon that never turns green. The round-trip test in
// protocol_test.go exists to make that class of defect a test failure instead.
package protocol

import (
	"fmt"
	"net/url"
	"strings"
)

// ─── headers the edge injects ────────────────────────────────────────────────
//
// Mirrors EDGE_SECRET_HEADER / EDGE_PEER_HEADER / FUNNEL_PEER in
// packages/contract/src/api.ts. Header names are compared case-insensitively by net/http,
// but they are written lowercase here so a grep across the two languages matches.
const (
	// HeaderEdgeSecret proves to the loopback Node server that a request arrived through
	// netedge and not from another process pointing a browser at localhost.
	HeaderEdgeSecret = "x-lc-edge-secret"

	// HeaderPeer carries the tailnet peer identity. It is unforgeable because netedge strips
	// any inbound copy before injecting its own.
	HeaderPeer = "x-lc-peer"

	// FunnelPeer is the literal identity used when there is no peer identity to be had:
	// behind Funnel every request arrives from a Tailscale relay. It doubles as the fallback
	// when WhoIs cannot answer, so the server's rate limiter sees one shared bucket for
	// "unidentified" rather than an invented per-request identity it might trust.
	FunnelPeer = "funnel"
)

// ─── control API routes ──────────────────────────────────────────────────────
//
// Mirrors EDGE_ROUTES.
const (
	RouteStatus       = "/edge/status"
	RouteStatusStream = "/edge/status/stream"
	RouteConfig       = "/edge/config"
	RouteTest         = "/edge/test"
	RouteLogin        = "/edge/login"
	RouteLogout       = "/edge/logout"
	RouteRestart      = "/edge/restart"
)

// ─── error codes ─────────────────────────────────────────────────────────────
//
// The subset of packages/contract/src/errors.ts that netedge can produce. Clients branch on
// these; they never string-match on the prose message.
const (
	ErrCodeUnauthenticated        = "unauthenticated"
	ErrCodeEdgeNotReady           = "edge_not_ready"
	ErrCodeEdgeLoginRequired      = "edge_login_required"
	ErrCodeEdgeCertUnavailable    = "edge_cert_unavailable"
	ErrCodeEdgeControlUnreachable = "edge_control_unreachable"
	ErrCodeEdgeModeUnsupported    = "edge_mode_unsupported"
	ErrCodeBadRequest             = "bad_request"
	ErrCodeInternal               = "internal"
)

// APIError is the body every failing control-API response carries. Mirrors apiErrorSchema.
type APIError struct {
	Error APIErrorBody `json:"error"`
}

// APIErrorBody is the inner object of APIError.
type APIErrorBody struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Detail  map[string]any `json:"detail,omitempty"`
}

// NewAPIError builds the wire body for a failure.
func NewAPIError(code, message string) APIError {
	return APIError{Error: APIErrorBody{Code: code, Message: message}}
}

// ─── network configuration ───────────────────────────────────────────────────

// NetworkMode selects the control plane. Mirrors networkModeSchema.
type NetworkMode string

const (
	// ModeDefault uses Tailscale's own coordination server. Certificates come free from its
	// ACME delegation and nothing is asked of the user.
	ModeDefault NetworkMode = "default"

	// ModeCustom uses a self-hosted Headscale. Headscale does not implement
	// /machine/set-dns, so `tailscale cert` cannot work there and a certificate strategy
	// must be chosen explicitly (design spec 2.3).
	ModeCustom NetworkMode = "custom"
)

// Expose selects tailnet-only or additionally published through Funnel. Mirrors exposeSchema.
type Expose string

const (
	ExposeTailnet Expose = "tailnet"
	ExposeFunnel  Expose = "funnel"
)

// CertStrategy selects where the TLS certificate comes from. Mirrors certStrategySchema.
type CertStrategy string

const (
	// CertControlPlane asks the local Tailscale daemon for a certificate
	// (LocalClient.CertPair). Only valid in ModeDefault.
	CertControlPlane CertStrategy = "control-plane"

	// CertExternalProxy means the operator terminates TLS in front of us; netedge serves
	// plain HTTP on the tailnet address and trusts the proxy.
	CertExternalProxy CertStrategy = "external-proxy"

	// CertDNS01 runs our own ACME DNS-01 client against a domain the user owns.
	CertDNS01 CertStrategy = "dns01"
)

// DNSProvider is the DNS API a dns01 configuration talks to. Mirrors dnsProviderSchema.
type DNSProvider string

const (
	DNSProviderCloudflare   DNSProvider = "cloudflare"
	DNSProviderDigitalOcean DNSProvider = "digitalocean"
	DNSProviderRoute53      DNSProvider = "route53"
	DNSProviderGandi        DNSProvider = "gandi"
)

// DefaultHostname mirrors the zod `.default('localcast')` on `hostname`.
const DefaultHostname = "localcast"

// RedactedPlaceholder is what a secret is replaced with on any path that a human or a log
// file can see. It is deliberately not a valid secret: Validate rejects a configuration that
// carries it, so a redacted value that is round-tripped back into a PUT fails loudly instead
// of silently becoming the auth key.
const RedactedPlaceholder = "[redacted]"

// NetworkConfig mirrors networkConfigSchema.
//
// AuthKey and DNSAPIToken are secrets. They live encrypted under Electron's safeStorage
// (Windows DPAPI) and are handed to netedge decrypted at runtime; they are never written to
// this process's config file and never logged. See WithoutSecrets and Redacted.
type NetworkConfig struct {
	Mode NetworkMode `json:"mode"`

	// ControlURL is required when Mode is ModeCustom and ignored otherwise.
	ControlURL string `json:"controlUrl,omitempty"`

	// AuthKey is the Headscale pre-authentication key. Secret.
	AuthKey string `json:"authKey,omitempty"`

	Expose       Expose       `json:"expose"`
	CertStrategy CertStrategy `json:"certStrategy"`

	// CertDomain is required for CertDNS01 and CertExternalProxy.
	CertDomain string `json:"certDomain,omitempty"`

	DNSProvider DNSProvider `json:"dnsProvider,omitempty"`

	// DNSAPIToken is the DNS provider credential. Secret.
	DNSAPIToken string `json:"dnsApiToken,omitempty"`

	Hostname string `json:"hostname"`
}

// ApplyDefaults fills the two fields the zod schema gives a `.default()`. Go's zero value is
// the empty string for both, which would otherwise cross the wire as an invalid enum.
func (c *NetworkConfig) ApplyDefaults() {
	if c.Expose == "" {
		c.Expose = ExposeTailnet
	}
	if c.Hostname == "" {
		c.Hostname = DefaultHostname
	}
}

// WithoutSecrets returns a copy with every secret removed entirely.
//
// This is what is written to disk and what GET /edge/config answers with. The alternative —
// answering with Redacted() — would put the placeholder on the wire, and a settings page
// that GETs, edits one field and PUTs back would then store the literal placeholder as the
// auth key. Absent is honest: Electron holds the encrypted copy and re-supplies it.
func (c NetworkConfig) WithoutSecrets() NetworkConfig {
	c.AuthKey = ""
	c.DNSAPIToken = ""
	return c
}

// Redacted returns a copy with every non-empty secret replaced by RedactedPlaceholder. Use
// it for display and logging, never for anything that is parsed back.
func (c NetworkConfig) Redacted() NetworkConfig {
	if c.AuthKey != "" {
		c.AuthKey = RedactedPlaceholder
	}
	if c.DNSAPIToken != "" {
		c.DNSAPIToken = RedactedPlaceholder
	}
	return c
}

// HasSecrets reports whether either secret is populated.
func (c NetworkConfig) HasSecrets() bool {
	return c.AuthKey != "" || c.DNSAPIToken != ""
}

// String implements fmt.Stringer so that formatting a NetworkConfig with %v or %s anywhere —
// including in an error wrapped with %w and printed later — cannot leak a secret. It is
// written field by field rather than by formatting the struct, because %v on the struct
// would recurse into String and blow the stack.
func (c NetworkConfig) String() string {
	r := c.Redacted()
	var b strings.Builder
	b.WriteString("NetworkConfig{mode=")
	b.WriteString(string(r.Mode))
	if r.ControlURL != "" {
		b.WriteString(" controlUrl=")
		b.WriteString(r.ControlURL)
	}
	if r.AuthKey != "" {
		b.WriteString(" authKey=")
		b.WriteString(r.AuthKey)
	}
	b.WriteString(" expose=")
	b.WriteString(string(r.Expose))
	b.WriteString(" certStrategy=")
	b.WriteString(string(r.CertStrategy))
	if r.CertDomain != "" {
		b.WriteString(" certDomain=")
		b.WriteString(r.CertDomain)
	}
	if r.DNSProvider != "" {
		b.WriteString(" dnsProvider=")
		b.WriteString(string(r.DNSProvider))
	}
	if r.DNSAPIToken != "" {
		b.WriteString(" dnsApiToken=")
		b.WriteString(r.DNSAPIToken)
	}
	b.WriteString(" hostname=")
	b.WriteString(r.Hostname)
	b.WriteString("}")
	return b.String()
}

// ─── validation ──────────────────────────────────────────────────────────────

// ValidationError is one rejected field. Field matches the zod issue `path`, so the settings
// page can highlight the same control the TypeScript validator would have highlighted.
type ValidationError struct {
	Field   string `json:"field"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e ValidationError) Error() string { return e.Field + ": " + e.Message }

// ValidationErrors is the whole set, so the caller can report every problem at once rather
// than making the user fix them one round trip at a time.
type ValidationErrors []ValidationError

func (v ValidationErrors) Error() string {
	parts := make([]string, 0, len(v))
	for _, e := range v {
		parts = append(parts, e.Error())
	}
	return strings.Join(parts, "; ")
}

// Code returns the machine code the control API should answer with: the first entry's, since
// that is the most specific reason the configuration was refused.
func (v ValidationErrors) Code() string {
	if len(v) == 0 {
		return ErrCodeBadRequest
	}
	return v[0].Code
}

// Validate mirrors the zod superRefine on networkConfigSchema, plus two checks zod cannot
// make: that enum values are inside their sets (TypeScript gets that from the type system)
// and that no secret is the redaction placeholder.
//
// It returns a nil error, not an empty ValidationErrors, when the configuration is sound —
// a non-nil interface holding an empty slice is the classic Go trap and `err != nil` is what
// every caller writes.
func (c NetworkConfig) Validate() error {
	var errs ValidationErrors
	add := func(field, code, message string) {
		errs = append(errs, ValidationError{Field: field, Code: code, Message: message})
	}

	switch c.Mode {
	case ModeDefault, ModeCustom:
	default:
		add("mode", ErrCodeBadRequest, fmt.Sprintf("unknown mode %q", c.Mode))
	}

	switch c.Expose {
	case ExposeTailnet, ExposeFunnel:
	default:
		add("expose", ErrCodeBadRequest, fmt.Sprintf("unknown expose %q", c.Expose))
	}

	switch c.CertStrategy {
	case CertControlPlane, CertExternalProxy, CertDNS01:
	default:
		add("certStrategy", ErrCodeBadRequest, fmt.Sprintf("unknown certStrategy %q", c.CertStrategy))
	}

	if c.Hostname == "" {
		add("hostname", ErrCodeBadRequest, "hostname is required")
	}

	if c.Mode == ModeCustom {
		switch {
		case c.ControlURL == "":
			add("controlUrl", ErrCodeBadRequest, "controlUrl is required in custom mode")
		default:
			if u, err := url.Parse(c.ControlURL); err != nil || !u.IsAbs() || (u.Scheme != "http" && u.Scheme != "https") {
				add("controlUrl", ErrCodeBadRequest, "controlUrl must be an absolute http(s) URL")
			}
		}

		if c.CertStrategy == CertControlPlane {
			add("certStrategy", ErrCodeEdgeModeUnsupported,
				"Headscale cannot issue certificates through the control plane; choose external-proxy or dns01")
		}

		if c.Expose == ExposeFunnel {
			add("expose", ErrCodeEdgeModeUnsupported,
				"Funnel is a Tailscale service and is not available on a self-hosted control server")
		}
	}

	if c.CertStrategy == CertDNS01 {
		if c.CertDomain == "" || c.DNSProvider == "" || c.DNSAPIToken == "" {
			add("certDomain", ErrCodeBadRequest, "dns01 needs a domain, a provider and an API token")
		}
		if c.DNSProvider != "" && !c.DNSProvider.Valid() {
			add("dnsProvider", ErrCodeBadRequest, fmt.Sprintf("unsupported dnsProvider %q", c.DNSProvider))
		}
	}

	if c.CertStrategy == CertExternalProxy && c.CertDomain == "" {
		add("certDomain", ErrCodeBadRequest, "external-proxy needs the public domain")
	}

	// A placeholder arriving as a secret means something read back a redacted config and put
	// it straight into a PUT. Accepting it would store "[redacted]" as the auth key and the
	// node would fail to register with an error that points nowhere near the cause.
	if c.AuthKey == RedactedPlaceholder {
		add("authKey", ErrCodeBadRequest, "authKey is the redaction placeholder, not a real key")
	}
	if c.DNSAPIToken == RedactedPlaceholder {
		add("dnsApiToken", ErrCodeBadRequest, "dnsApiToken is the redaction placeholder, not a real token")
	}

	if len(errs) == 0 {
		return nil
	}
	return errs
}

// Valid reports whether the provider is one netedge can drive.
func (p DNSProvider) Valid() bool {
	switch p {
	case DNSProviderCloudflare, DNSProviderDigitalOcean, DNSProviderRoute53, DNSProviderGandi:
		return true
	}
	return false
}

// ─── status ──────────────────────────────────────────────────────────────────

// EdgeState is what the tray dot and the settings page render. Mirrors edgeStateSchema.
// Nothing here leaks transport detail.
type EdgeState string

const (
	StateStopped              EdgeState = "stopped"
	StateStarting             EdgeState = "starting"
	StateLoginRequired        EdgeState = "login-required"
	StateConnecting           EdgeState = "connecting"
	StateObtainingCertificate EdgeState = "obtaining-certificate"
	StateConnected            EdgeState = "connected"
	StateError                EdgeState = "error"
)

// AllEdgeStates returns the seven states in contract order. The protocol test asserts both
// the count and the spelling, so adding an eighth state to netedge without adding it to
// netedge.ts fails here rather than at runtime in the renderer.
func AllEdgeStates() []EdgeState {
	return []EdgeState{
		StateStopped,
		StateStarting,
		StateLoginRequired,
		StateConnecting,
		StateObtainingCertificate,
		StateConnected,
		StateError,
	}
}

// Valid reports whether s is one of the seven contract states.
func (s EdgeState) Valid() bool {
	for _, k := range AllEdgeStates() {
		if s == k {
			return true
		}
	}
	return false
}

// EdgeStatus mirrors edgeStatusSchema.
//
// Every nullable field is a pointer with no omitempty, so an absent value marshals as an
// explicit `null`. zod's `.nullable()` requires the key to be present; `omitempty` would drop
// it and the parse would fail.
type EdgeStatus struct {
	State EdgeState `json:"state"`

	// Host is the MagicDNS FQDN once known, e.g. localcast.tail1234.ts.net.
	Host *string `json:"host"`

	// FunnelURL is the public URL when Expose is ExposeFunnel.
	FunnelURL *string `json:"funnelUrl"`

	// LoginURL is present only while State is StateLoginRequired. Electron opens it; netedge
	// never launches a browser itself.
	LoginURL *string `json:"loginUrl"`

	ErrorCode    *string `json:"errorCode"`
	ErrorMessage *string `json:"errorMessage"`

	// CertExpiresAt is Unix milliseconds, matching JavaScript's Date semantics on the other
	// side of the wire. UpdatedAt uses the same unit for the same reason.
	CertExpiresAt *int64 `json:"certExpiresAt"`

	Peers     int   `json:"peers"`
	UpdatedAt int64 `json:"updatedAt"`
}

// ─── test result ─────────────────────────────────────────────────────────────

// MessageLevel mirrors the level enum inside edgeTestResultSchema.
type MessageLevel string

const (
	MessageInfo  MessageLevel = "info"
	MessageWarn  MessageLevel = "warn"
	MessageError MessageLevel = "error"
)

// TestMessage is one human-readable finding from a dry run.
type TestMessage struct {
	Level MessageLevel `json:"level"`
	Text  string       `json:"text"`
}

// EdgeTestResult mirrors edgeTestResultSchema.
type EdgeTestResult struct {
	Ok               bool `json:"ok"`
	ControlReachable bool `json:"controlReachable"`

	// CertificateViable reports whether the chosen strategy can actually produce a
	// certificate — not whether one exists yet.
	CertificateViable bool `json:"certificateViable"`

	// Messages must never marshal as null: zod requires an array. NewEdgeTestResult
	// initialises it for that reason.
	Messages []TestMessage `json:"messages"`

	// LoginURL is populated when the control server offers an interactive login instead of
	// accepting a key.
	LoginURL *string `json:"loginUrl"`
}

// NewEdgeTestResult returns a result with Messages already non-nil.
func NewEdgeTestResult() EdgeTestResult {
	return EdgeTestResult{Messages: []TestMessage{}}
}

// HasError reports whether any message is error level.
func (r EdgeTestResult) HasError() bool {
	for _, m := range r.Messages {
		if m.Level == MessageError {
			return true
		}
	}
	return false
}

// ─── stdout events ───────────────────────────────────────────────────────────

// EventType is the discriminant of edgeStdoutEventSchema.
type EventType string

const (
	EventReady  EventType = "ready"
	EventStatus EventType = "status"
	EventLog    EventType = "log"
)

// LogLevel mirrors the level enum on the `log` variant.
type LogLevel string

const (
	LogDebug LogLevel = "debug"
	LogInfo  LogLevel = "info"
	LogWarn  LogLevel = "warn"
	LogError LogLevel = "error"
)

// EdgeStdoutEvent is the newline-delimited JSON netedge writes to stdout.
//
// Go has no sum type, so the three variants share one struct and the fields that do not
// belong to the current variant are nil and omitted. Field order matters: encoding/json
// emits in declaration order, and the protocol test compares exact JSON so the emitted shape
// cannot drift from the discriminated union.
type EdgeStdoutEvent struct {
	Type        EventType   `json:"type"`
	ControlPort *int        `json:"controlPort,omitempty"`
	Status      *EdgeStatus `json:"status,omitempty"`
	Level       *LogLevel   `json:"level,omitempty"`
	Message     *string     `json:"message,omitempty"`
}

// ReadyEvent announces the loopback control port. It is emitted before anything else,
// because Electron cannot talk to netedge until it knows the port.
func ReadyEvent(controlPort int) EdgeStdoutEvent {
	return EdgeStdoutEvent{Type: EventReady, ControlPort: Ptr(controlPort)}
}

// StatusEvent carries a full status snapshot. Snapshots rather than deltas, so a consumer
// that misses one is still correct after the next.
func StatusEvent(s EdgeStatus) EdgeStdoutEvent {
	return EdgeStdoutEvent{Type: EventStatus, Status: &s}
}

// LogEvent carries a line for Electron's log file.
func LogEvent(level LogLevel, message string) EdgeStdoutEvent {
	return EdgeStdoutEvent{Type: EventLog, Level: &level, Message: &message}
}

// Ptr returns a pointer to v. The contract has nine nullable fields; without this every
// assignment needs a named temporary.
func Ptr[T any](v T) *T { return &v }
