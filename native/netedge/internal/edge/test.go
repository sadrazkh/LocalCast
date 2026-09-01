package edge

import (
	"context"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

// DefaultControlURL is Tailscale's coordination server, the control plane `default` mode
// talks to.
const DefaultControlURL = "https://controlplane.tailscale.com"

// controlProbePath is the endpoint both Tailscale's control server and Headscale serve: it
// returns the server's public key and therefore proves that whatever answered actually
// speaks the control protocol, rather than merely that a TCP port was open. A captive
// portal, a parked domain or a misconfigured reverse proxy all pass a bare TCP dial and all
// fail this.
//
// VERIFY: the capability version in the query string moves with tailscale releases. Both
// implementations answer regardless of its value, so this is a compatibility nicety rather
// than a requirement.
const controlProbePath = "/key?v=106"

// controlProbeTimeout keeps the settings page responsive. The user is looking at a form.
const controlProbeTimeout = 10 * time.Second

// TestDeps are the collaborators RunTest needs, injected so the decision matrix can be
// exercised without touching the network.
type TestDeps struct {
	HTTPClient *http.Client

	// DefaultControlURL overrides the coordination server probed in `default` mode. Empty
	// means the real one.
	DefaultControlURL string
}

// RunTest is the dry run behind POST /edge/test.
//
// It exists because the alternative is worse than a rejected form: a configuration that
// cannot possibly obtain a certificate — Headscale with the control-plane strategy, say —
// starts perfectly, connects perfectly, and then serves nothing, presenting to the user as a
// "connecting…" spinner that never resolves. Deciding viability while the user is still
// looking at the form turns that into a sentence they can act on (design spec 2.3).
//
// The result is truthful about what was and was not checked: reachability is a real request,
// viability is a decision about the configuration, and neither is inferred from the other.
func RunTest(ctx context.Context, cfg protocol.NetworkConfig, deps TestDeps) protocol.EdgeTestResult {
	cfg.ApplyDefaults()
	res := protocol.NewEdgeTestResult()

	add := func(level protocol.MessageLevel, format string, args ...any) {
		res.Messages = append(res.Messages, protocol.TestMessage{
			Level: level,
			Text:  fmt.Sprintf(format, args...),
		})
	}

	// 1. Shape. A configuration that is internally inconsistent is reported without a
	//    network round trip: there is nothing to learn from the wire about a missing field.
	res.Messages = append(res.Messages, modeMessages(cfg)...)

	// 2. Certificate viability, decided from the configuration alone.
	viable, certMsgs := certificateViability(cfg)
	res.CertificateViable = viable
	res.Messages = append(res.Messages, certMsgs...)

	// 3. Reachability, an actual request.
	reachable, reachMsgs := probeControl(ctx, cfg, deps)
	res.ControlReachable = reachable
	res.Messages = append(res.Messages, reachMsgs...)

	// LoginURL stays nil. Producing a real interactive login URL means registering a node
	// with the control server, and a dry run that leaves a half-registered machine in the
	// user's Headscale would be a rude thing to do to someone who pressed "Test". The login
	// happens after saving, through POST /edge/login.
	if cfg.Mode == protocol.ModeCustom && cfg.AuthKey == "" {
		add(protocol.MessageInfo,
			"No pre-authentication key is set, so this node will ask you to sign in to %s after you save.",
			cfg.ControlURL)
	}

	res.Ok = res.ControlReachable && res.CertificateViable && !res.HasError()
	return res
}

// modeMessages reports the problems and the warnings that belong to the control plane rather
// than to the certificate.
func modeMessages(cfg protocol.NetworkConfig) []protocol.TestMessage {
	var out []protocol.TestMessage
	add := func(level protocol.MessageLevel, format string, args ...any) {
		out = append(out, protocol.TestMessage{Level: level, Text: fmt.Sprintf(format, args...)})
	}

	if cfg.Mode == protocol.ModeCustom {
		if cfg.ControlURL == "" {
			add(protocol.MessageError, "A self-hosted control server needs its URL.")
		} else if u, err := url.Parse(cfg.ControlURL); err == nil && u.Scheme == "http" {
			// The pre-authentication key is sent to this URL. Over plain HTTP anyone on the
			// path can take it and register their own node on the user's tailnet.
			add(protocol.MessageWarn,
				"%s is plain HTTP; the pre-authentication key would be sent unencrypted.", cfg.ControlURL)
		}
	}

	if cfg.Hostname == "" {
		add(protocol.MessageError, "A hostname is required; it becomes the node's name on the tailnet.")
	} else if !plausibleHostname(cfg.Hostname) {
		add(protocol.MessageWarn,
			"%q is not a plain DNS label; the control server will rewrite it and the address clients see "+
				"may not be the one you typed.", cfg.Hostname)
	}

	return out
}

// certificateViability is the decision matrix, and the only authority on certificate
// messages in a test result.
//
//	mode    × strategy        → viable?
//	default × control-plane   → yes, and it is the zero-input path
//	default × external-proxy  → yes, given a domain; TLS is the operator's problem
//	default × dns01           → yes, given domain + provider + token; more work than needed
//	custom  × control-plane   → NO. Headscale does not implement /machine/set-dns
//	custom  × external-proxy  → yes, given a domain
//	custom  × dns01           → yes, given domain + provider + token
//	custom  + funnel          → NO, whatever the strategy. Funnel is a Tailscale service
func certificateViability(cfg protocol.NetworkConfig) (bool, []protocol.TestMessage) {
	var out []protocol.TestMessage
	add := func(level protocol.MessageLevel, format string, args ...any) {
		out = append(out, protocol.TestMessage{Level: level, Text: fmt.Sprintf(format, args...)})
	}

	// Funnel on a self-hosted control server is refused before the strategy is even looked
	// at: there is no ingress to terminate TLS and no certificate to be had.
	if cfg.Mode == protocol.ModeCustom && cfg.Expose == protocol.ExposeFunnel {
		add(protocol.MessageError,
			"Funnel is a Tailscale service and Headscale has not implemented it (headscale#1040), "+
				"so a self-hosted control server cannot publish this node to the internet. "+
				"Use tailnet-only, or switch to the default coordination server. [%s]",
			protocol.ErrCodeEdgeModeUnsupported)
		return false, out
	}

	if cfg.Mode == protocol.ModeCustom && cfg.CertStrategy == protocol.CertControlPlane {
		add(protocol.MessageError,
			"Headscale cannot issue a certificate. Issuance needs the control server to implement "+
				"/machine/set-dns and write the ACME TXT records for the base domain; Headscale has not "+
				"(headscale#2527, headscale#2137), so `tailscale cert` fails there. "+
				"Choose external-proxy if you already terminate TLS in front of this machine, "+
				"or dns01 to let LocalCast get its own certificate for a domain you own. [%s]",
			protocol.ErrCodeEdgeModeUnsupported)
		return false, out
	}

	switch cfg.CertStrategy {
	case protocol.CertControlPlane:
		if cfg.Expose == protocol.ExposeFunnel {
			add(protocol.MessageInfo,
				"Funnel terminates TLS at Tailscale's ingress using the control-plane certificate. "+
					"Nothing is asked of you.")
		} else {
			add(protocol.MessageInfo,
				"Tailscale's control plane issues the certificate for this node's MagicDNS name. "+
					"Nothing is asked of you.")
		}
		return true, out

	case protocol.CertExternalProxy:
		if cfg.CertDomain == "" {
			add(protocol.MessageError, "external-proxy needs the public domain your own proxy serves.")
			return false, out
		}
		add(protocol.MessageWarn,
			"LocalCast will serve plain HTTP on the tailnet address and trust your proxy to terminate "+
				"TLS for %s. Nothing here can verify that the proxy exists or that it is configured "+
				"correctly; if it is not, clients will see a connection error rather than a warning.",
			cfg.CertDomain)
		if cfg.Expose == protocol.ExposeFunnel {
			add(protocol.MessageWarn,
				"Funnel already terminates TLS, so the external proxy is not used for public traffic.")
		}
		return true, out

	case protocol.CertDNS01:
		var missing []string
		if cfg.CertDomain == "" {
			missing = append(missing, "a domain")
		}
		if cfg.DNSProvider == "" {
			missing = append(missing, "a DNS provider")
		}
		if cfg.DNSAPIToken == "" {
			missing = append(missing, "an API token")
		}
		if len(missing) > 0 {
			add(protocol.MessageError, "dns01 needs %s.", strings.Join(missing, ", "))
			return false, out
		}
		if !cfg.DNSProvider.Valid() {
			add(protocol.MessageError,
				"%q is not a DNS provider LocalCast can drive. Supported: cloudflare, digitalocean, "+
					"route53, gandi.", cfg.DNSProvider)
			return false, out
		}
		add(protocol.MessageInfo,
			"LocalCast will obtain a Let's Encrypt certificate for %s over DNS-01 using %s, cache it in "+
				"the state directory and renew it automatically.", cfg.CertDomain, cfg.DNSProvider)
		if cfg.Mode == protocol.ModeDefault {
			add(protocol.MessageWarn,
				"In default mode the control plane issues a certificate with no DNS credentials at all; "+
					"dns01 is only worth the extra setup if you want the node reachable under your own "+
					"domain.")
		}
		if cfg.Expose == protocol.ExposeFunnel {
			add(protocol.MessageWarn,
				"Funnel terminates TLS itself, so the DNS-01 certificate will not be used for public "+
					"traffic.")
		}
		return true, out

	default:
		add(protocol.MessageError, "%q is not a certificate strategy LocalCast knows.", cfg.CertStrategy)
		return false, out
	}
}

// probeControl makes one request to the control server.
func probeControl(ctx context.Context, cfg protocol.NetworkConfig, deps TestDeps) (bool, []protocol.TestMessage) {
	var out []protocol.TestMessage
	add := func(level protocol.MessageLevel, format string, args ...any) {
		out = append(out, protocol.TestMessage{Level: level, Text: fmt.Sprintf(format, args...)})
	}

	base := cfg.ControlURL
	if cfg.Mode == protocol.ModeDefault {
		base = deps.DefaultControlURL
		if base == "" {
			base = DefaultControlURL
		}
	}
	if base == "" {
		// modeMessages has already said why; do not claim reachability we never tested.
		return false, out
	}

	u, err := url.Parse(base)
	if err != nil || !u.IsAbs() || (u.Scheme != "http" && u.Scheme != "https") {
		add(protocol.MessageError, "%q is not an absolute http(s) URL. [%s]", base, protocol.ErrCodeBadRequest)
		return false, out
	}

	client := deps.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: controlProbeTimeout}
	}

	probeCtx, cancel := context.WithTimeout(ctx, controlProbeTimeout)
	defer cancel()

	target := strings.TrimRight(base, "/") + controlProbePath
	req, err := http.NewRequestWithContext(probeCtx, http.MethodGet, target, nil)
	if err != nil {
		add(protocol.MessageError, "could not build a request for %s: %v", target, err)
		return false, out
	}

	resp, err := client.Do(req)
	if err != nil {
		// The error text is the user's only clue whether this is DNS, a firewall or a
		// certificate, so it is passed through rather than flattened into "unreachable".
		add(protocol.MessageError, "Cannot reach the control server at %s: %v [%s]",
			base, err, protocol.ErrCodeEdgeControlUnreachable)
		return false, out
	}
	defer func() { _ = resp.Body.Close() }()

	switch {
	case resp.StatusCode == http.StatusOK:
		add(protocol.MessageInfo, "The control server at %s answered and speaks the Tailscale protocol.", base)
		return true, out
	default:
		// Something answered, so the network path is fine; but a control server that does
		// not serve its own key is almost certainly the wrong URL — a landing page, or a
		// proxy in front of Headscale that is not passing /key through.
		add(protocol.MessageWarn,
			"%s answered with HTTP %d instead of a node key. The address is reachable, but it may not "+
				"be a Tailscale or Headscale control server.", base, resp.StatusCode)
		return true, out
	}
}

// plausibleHostname reports whether s is a plain DNS label. The control server rewrites
// anything else, and a user who typed "Ali's PC" deserves to know before the address they
// were shown stops matching the one clients resolve.
func plausibleHostname(s string) bool {
	if s == "" || len(s) > 63 {
		return false
	}
	for i, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
		case r >= 'A' && r <= 'Z':
		case r == '-' && i != 0 && i != len(s)-1:
		default:
			return false
		}
	}
	return true
}
