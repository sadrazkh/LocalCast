package edge

import (
	"fmt"
	"net/url"
	"strings"
	"sync"
	"unicode"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

// loginLineMarkers name the log lines that carry an interactive login URL and nothing else.
//
// Scanning tsnet's output is the second, independent way netedge learns the sign-in link.
// The status poll is the documented source, but a sign-in link that never reaches the UI is
// the single worst failure this component has — the user simply cannot get in — and these
// lines are the ones that have been watched arriving on a real machine.
//
// Anchoring on a phrase rather than on "any https:// URL in any line" is what makes the
// second source safe. tsnet logs the coordination server's own address constantly
// (`fetch control key: Get "https://controlplane.tailscale.com/key?v=109"`, the DERP map,
// health warnings); publishing one of those as a sign-in link would send the user to a page
// that cannot sign them in and would look exactly like the bug this replaces.
//
//   - "To start this tsnet server" is tsnet's user-facing prompt, repeated every five
//     seconds for as long as the node waits (tsnet.Server.printAuthURLLoop).
//   - "AuthURL is" is controlclient's line, logged as `control: AuthURL is <url>`. It is
//     debug-level and, on the runs measured here, arrives about five seconds earlier.
//
// Neither phrase mentions Tailscale's own domain, so both work unchanged against a
// self-hosted Headscale, whose URL is on a completely different host.
var loginLineMarkers = [...]string{
	"To start this tsnet server",
	"AuthURL is",
}

// hasLoginLineMarker reports whether s could be one of the lines above.
//
// It is deliberately callable on an unformatted format string: tsnet passes format and args
// through to its Logf hook untouched, and the marker lives in the format half. Checking
// there means the voluminous debug stream is not run through fmt.Sprintf just to be
// discarded by the level filter a moment later.
func hasLoginLineMarker(s string) bool {
	for _, m := range loginLineMarkers {
		if strings.Contains(s, m) {
			return true
		}
	}
	return false
}

// parseLoginURL returns the interactive login URL carried by a tsnet log line, or "" if the
// line is not one of them or holds nothing usable.
//
// It takes the first https URL on the line, which is what both marked lines end with. A
// failure to parse is not an error worth propagating: this is a scanner over log text, and
// "this line was not a login prompt after all" is an ordinary answer, not a fault.
func parseLoginURL(line string) string {
	if !hasLoginLineMarker(line) {
		return ""
	}

	i := strings.Index(line, "https://")
	if i < 0 {
		return ""
	}
	raw := line[i:]
	if j := strings.IndexFunc(raw, unicode.IsSpace); j >= 0 {
		raw = raw[:j]
	}
	// Trailing sentence punctuation is not part of the URL. Tailscale does not add any today,
	// but handing the browser a URL with a stray full stop is a silent failure and the guard
	// costs nothing.
	raw = strings.TrimRight(raw, `.,;:!?)]}>"'`)

	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return ""
	}
	// The raw text is returned rather than u.String() so the URL handed to the browser is
	// byte-for-byte the one the control server issued; these links are single-use and
	// normalisation is not worth the risk.
	return raw
}

// loginPublisher is the one gate through which an interactive login URL reaches the status
// store, whichever of the two sources found it.
type loginPublisher struct {
	status *StatusStore
	logf   logFunc

	// Both sources run on their own goroutines. The lock makes read-then-publish atomic, so
	// two of them that see the same URL at the same moment still produce one status change.
	mu sync.Mutex
}

func newLoginPublisher(status *StatusStore, logf logFunc) *loginPublisher {
	if logf == nil {
		logf = func(protocol.LogLevel, string, ...any) {}
	}
	return &loginPublisher{status: status, logf: logf}
}

// publish moves the status to login-required and reports whether that changed anything.
//
// The repeat check is the point. The status poll runs twice a second and tsnet reprints its
// prompt every five seconds, both with the same URL, for as long as the user has not signed
// in — which can be minutes. Republishing each time would push an identical snapshot to
// stdout and to every SSE subscriber several times a second, and the UI would see a status
// change that carries no news.
//
// The check is against the store rather than against a remembered string on purpose: if the
// node authenticates and later needs the *same* URL again, the store will no longer be in
// login-required, and the URL must be published anew rather than swallowed as a repeat.
func (p *loginPublisher) publish(loginURL string) bool {
	if p == nil || loginURL == "" {
		return false
	}

	p.mu.Lock()
	defer p.mu.Unlock()

	cur := p.status.Get()
	if cur.State == protocol.StateLoginRequired && cur.LoginURL != nil && *cur.LoginURL == loginURL {
		return false
	}
	if err := p.status.SetLoginRequired(loginURL); err != nil {
		p.logf(protocol.LogWarn, "%v", err)
		return false
	}
	return true
}

// tsnetLogf wraps one of tsnet's two log sinks so every line it writes is forwarded at level
// and, if it carries a login URL, published as well.
//
// A line that repeats a URL already published drops to debug. tsnet reprints its prompt every
// five seconds until the user signs in, and at info that is a log line every five seconds for
// ever — noise that buries whatever else is happening in the process.
func tsnetLogf(level protocol.LogLevel, pub *loginPublisher, out logFunc) func(string, ...any) {
	return func(format string, args ...any) {
		if !hasLoginLineMarker(format) {
			out(level, format, args...)
			return
		}

		// Formatted only now that the line is known to be interesting; see hasLoginLineMarker.
		line := fmt.Sprintf(format, args...)
		lvl := level
		if loginURL := parseLoginURL(line); loginURL != "" && !pub.publish(loginURL) {
			lvl = protocol.LogDebug
		}
		// "%s" rather than passing line back as a format: it now contains the URL, and a
		// control server that ever put a percent sign in one would otherwise corrupt the line.
		out(lvl, "%s", line)
	}
}
