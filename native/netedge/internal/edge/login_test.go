package edge

import (
	"fmt"
	"strings"
	"testing"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

// TestParseLoginURL covers the second source of the sign-in link. The first case is the exact
// line copied from a real netedge run; the rest are the ways it can go wrong.
func TestParseLoginURL(t *testing.T) {
	cases := []struct {
		name string
		line string
		want string
	}{
		{
			name: "tsnet prompt, verbatim from a real run",
			line: "To start this tsnet server, restart with TS_AUTHKEY set, or go to: https://login.tailscale.com/a/16fe082601b32f",
			want: "https://login.tailscale.com/a/16fe082601b32f",
		},
		{
			name: "controlclient line, which arrives about five seconds earlier",
			line: "control: AuthURL is https://login.tailscale.com/a/10273b1a01e97a",
			want: "https://login.tailscale.com/a/10273b1a01e97a",
		},
		{
			name: "self-hosted control server on a different host and path",
			line: "To start this tsnet server, restart with TS_AUTHKEY set, or go to: https://headscale.example.org:8443/register/nodekey:abc123",
			want: "https://headscale.example.org:8443/register/nodekey:abc123",
		},
		{
			name: "marked line with no URL at all",
			line: "To start this tsnet server, restart with TS_AUTHKEY set, or go to: ",
			want: "",
		},
		{
			name: "no marker and no URL",
			line: "magicsock: disco key = d:de6ed0d02e96f68f",
			want: "",
		},
		{
			// This is the line the marker exists to reject. tsnet logs the coordination
			// server's own address constantly, and publishing one as a sign-in link would
			// send the user somewhere that cannot sign them in.
			name: "an unmarked line that does contain an https URL",
			line: `control: [v1] TryLogin: fetch control key: Get "https://controlplane.tailscale.com/key?v=109": context canceled`,
			want: "",
		},
		{
			name: "plain http is not a link worth opening",
			line: "To start this tsnet server, restart with TS_AUTHKEY set, or go to: http://headscale.example.org/register/nodekey:abc",
			want: "",
		},
		{
			name: "trailing punctuation is not part of the URL",
			line: "control: AuthURL is https://login.tailscale.com/a/16fe082601b32f.",
			want: "https://login.tailscale.com/a/16fe082601b32f",
		},
		{
			name: "the first URL on the line wins",
			line: "control: AuthURL is https://login.tailscale.com/a/first https://login.tailscale.com/a/second",
			want: "https://login.tailscale.com/a/first",
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parseLoginURL(tc.line); got != tc.want {
				t.Errorf("parseLoginURL(%q) = %q, want %q", tc.line, got, tc.want)
			}
		})
	}
}

// TestLoginPublisherDeduplicates is the guard against the UI seeing a status change every few
// seconds: tsnet reprints its prompt for as long as the user has not signed in.
func TestLoginPublisherDeduplicates(t *testing.T) {
	const url = "https://login.tailscale.com/a/16fe082601b32f"

	s := NewStatusStore(fixedClock())
	mustAll(t, s.SetStarting(), s.SetConnecting())

	ch, cancel := s.Subscribe()
	defer cancel()

	pub := newLoginPublisher(s, nil)

	if !pub.publish(url) {
		t.Fatal("the first login URL was not published")
	}
	if pub.publish(url) {
		t.Error("the same login URL was published twice")
	}
	if pub.publish(url) {
		t.Error("the same login URL was published a third time")
	}
	if got := len(ch); got != 1 {
		t.Errorf("%d snapshots for one login URL repeated three times, want 1", got)
	}

	got := s.Get()
	if got.State != protocol.StateLoginRequired {
		t.Errorf("state = %q, want login-required", got.State)
	}
	if got.LoginURL == nil || *got.LoginURL != url {
		t.Errorf("loginUrl = %v, want %q", got.LoginURL, url)
	}

	// An empty URL is not a login prompt and must not move the state machine.
	if pub.publish("") {
		t.Error("an empty URL was published")
	}

	// A different URL is news and must get through.
	const other = "https://login.tailscale.com/a/0000000000000f"
	if !pub.publish(other) {
		t.Error("a new login URL was suppressed as a repeat")
	}
}

// TestLoginPublisherRepublishesAfterLeavingLoginRequired: the repeat check is against the
// store, not against a remembered string, precisely so that a node which leaves
// login-required and then needs the *same* URL again is not left with no way to say so.
// Tailscale reuses an auth URL for up to seven days, so "same URL" is the ordinary case, not
// an exotic one.
func TestLoginPublisherRepublishesAfterLeavingLoginRequired(t *testing.T) {
	const url = "https://login.tailscale.com/a/16fe082601b32f"

	s := NewStatusStore(fixedClock())
	mustAll(t, s.SetStarting(), s.SetConnecting())
	pub := newLoginPublisher(s, nil)

	if !pub.publish(url) {
		t.Fatal("the first login URL was not published")
	}

	// The key is revoked while the node is connecting, which the state machine allows, and
	// leaving login-required clears the URL from the snapshot.
	mustAll(t, s.SetConnecting())
	if got := s.Get(); got.LoginURL != nil {
		t.Fatalf("the login URL survived into connecting: %q", *got.LoginURL)
	}
	if !pub.publish(url) {
		t.Error("the same URL was suppressed as a repeat after the state had moved on")
	}
	if got := s.Get(); got.State != protocol.StateLoginRequired {
		t.Errorf("state = %q, want login-required", got.State)
	}

	// The same holds across a restart in place, which is how a mode switch reaches this.
	mustAll(t, s.SetStarting(), s.SetConnecting())
	if !pub.publish(url) {
		t.Error("the same URL was suppressed as a repeat after a restart")
	}
}

// TestTsnetLogfPublishesAndQuietens covers both halves of the log hook: the URL reaches the
// status store, and the line that repeats it drops from info to debug.
func TestTsnetLogfPublishesAndQuietens(t *testing.T) {
	const url = "https://login.tailscale.com/a/16fe082601b32f"

	s := NewStatusStore(fixedClock())
	mustAll(t, s.SetStarting(), s.SetConnecting())

	type entry struct {
		level protocol.LogLevel
		text  string
	}
	var logged []entry
	logf := func(level protocol.LogLevel, format string, args ...any) {
		logged = append(logged, entry{level, fmt.Sprintf(format, args...)})
	}

	hook := tsnetLogf(protocol.LogInfo, newLoginPublisher(s, logf), logf)

	hook("To start this tsnet server, restart with TS_AUTHKEY set, or go to: %s", url)
	hook("To start this tsnet server, restart with TS_AUTHKEY set, or go to: %s", url)
	hook("magicsock: disco key = %s", "d:de6ed0d02e96f68f")

	if got := s.Get(); got.LoginURL == nil || *got.LoginURL != url {
		t.Fatalf("the log hook did not publish the login URL: %+v", got)
	}
	if len(logged) != 3 {
		t.Fatalf("logged %d lines, want 3: %+v", len(logged), logged)
	}
	if logged[0].level != protocol.LogInfo {
		t.Errorf("the first login prompt was logged at %q, want info", logged[0].level)
	}
	if logged[1].level != protocol.LogDebug {
		t.Errorf("the repeated login prompt was logged at %q, want debug", logged[1].level)
	}
	if logged[2].level != protocol.LogInfo {
		t.Errorf("an ordinary line was logged at %q, want the sink's own level", logged[2].level)
	}
	for _, e := range logged[:2] {
		if !strings.Contains(e.text, url) {
			t.Errorf("the login URL is missing from the log line %q", e.text)
		}
	}
}
