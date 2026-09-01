package edge

import (
	"testing"
	"time"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

// fixedClock returns a clock that advances a millisecond per call, so UpdatedAt is both
// deterministic and strictly increasing.
func fixedClock() func() time.Time {
	base := time.Date(2026, 9, 1, 12, 0, 0, 0, time.UTC)
	var n int64
	return func() time.Time {
		n++
		return base.Add(time.Duration(n) * time.Millisecond)
	}
}

func TestCanTransition(t *testing.T) {
	const (
		stopped    = protocol.StateStopped
		starting   = protocol.StateStarting
		login      = protocol.StateLoginRequired
		connecting = protocol.StateConnecting
		cert       = protocol.StateObtainingCertificate
		connected  = protocol.StateConnected
		failed     = protocol.StateError
	)

	cases := []struct {
		from, to protocol.EdgeState
		want     bool
		why      string
	}{
		// the happy path, start to finish
		{stopped, starting, true, "a start begins here"},
		{starting, connecting, true, "the node reached the control plane"},
		{connecting, cert, true, "authenticated, now fetching a certificate"},
		{cert, connected, true, "serving"},
		{connecting, connected, true, "external-proxy serves plain HTTP and skips the certificate step"},

		// the interactive login detour
		{starting, login, true, "no auth key, the user must sign in"},
		{login, connecting, true, "the user signed in"},
		{login, cert, true, "signed in and the node was already up"},
		{connecting, login, true, "the key was revoked mid-connect"},

		// restart in place: spec 2.4 says switching control planes must not exit the process
		{connected, starting, true, "restart in place"},
		{failed, starting, true, "restart in place after a failure"},
		{login, starting, true, "restart in place while waiting for a login"},
		{cert, starting, true, "restart in place while fetching a certificate"},

		// anything can fail and anything can be shut down
		{starting, failed, true, ""},
		{connecting, failed, true, ""},
		{cert, failed, true, ""},
		{connected, failed, true, ""},
		{login, failed, true, ""},
		{connected, stopped, true, ""},
		{failed, stopped, true, ""},

		// renewal and reconnection
		{connected, cert, true, "the certificate is being renewed"},
		{connected, connecting, true, "the tailnet dropped"},

		// idempotent re-publish
		{connected, connected, true, "a peer count change re-publishes the same state"},
		{stopped, stopped, true, ""},

		// the illegal ones: these are what the table exists to reject
		{stopped, connected, false, "a stopped node cannot be serving"},
		{stopped, connecting, false, "a start always passes through starting"},
		{stopped, cert, false, ""},
		{stopped, login, false, ""},
		{starting, connected, false, "connecting is not optional"},
		{starting, cert, false, "the node must reach the control plane first"},
		{cert, connecting, false, "certificates are not fetched before authentication"},
		{cert, login, false, ""},
		{failed, connected, false, "a failed node restarts, it does not resume"},
		{failed, connecting, false, ""},

		// nonsense states
		{protocol.EdgeState("bogus"), connected, false, ""},
		{connected, protocol.EdgeState("bogus"), false, ""},
	}

	for _, tc := range cases {
		got := CanTransition(tc.from, tc.to)
		if got != tc.want {
			t.Errorf("CanTransition(%s, %s) = %v, want %v (%s)", tc.from, tc.to, got, tc.want, tc.why)
		}
	}
}

func TestStatusStoreStartsStopped(t *testing.T) {
	s := NewStatusStore(fixedClock())
	got := s.Get()
	if got.State != protocol.StateStopped {
		t.Errorf("initial state = %q, want stopped", got.State)
	}
	if got.UpdatedAt == 0 {
		t.Error("initial status must be stamped")
	}
	if got.Host != nil || got.LoginURL != nil || got.ErrorCode != nil {
		t.Errorf("initial status must be empty: %+v", got)
	}
}

func TestTransitionRejectsIllegalMoves(t *testing.T) {
	s := NewStatusStore(fixedClock())

	if err := s.Transition(protocol.StateConnected, nil); err == nil {
		t.Fatal("stopped -> connected must be refused")
	}
	if got := s.Get().State; got != protocol.StateStopped {
		t.Errorf("a refused transition changed the state to %q", got)
	}

	if err := s.SetStarting(); err != nil {
		t.Fatalf("stopped -> starting: %v", err)
	}
	if got := s.Get().State; got != protocol.StateStarting {
		t.Errorf("state = %q, want starting", got)
	}
}

// TestClearStaleFields is the reason Transition exists rather than a plain setter: the UI
// renders these fields verbatim, so carrying one into a state where it is no longer true
// puts a lie on the screen.
func TestClearStaleFields(t *testing.T) {
	s := NewStatusStore(fixedClock())

	if err := s.SetStarting(); err != nil {
		t.Fatal(err)
	}
	if err := s.SetLoginRequired("https://login.tailscale.com/a/abcdef"); err != nil {
		t.Fatal(err)
	}
	if got := s.Get(); got.LoginURL == nil || *got.LoginURL == "" {
		t.Fatalf("login URL not published: %+v", got)
	}

	if err := s.SetConnecting(); err != nil {
		t.Fatal(err)
	}
	if got := s.Get(); got.LoginURL != nil {
		t.Errorf("a consumed login URL survived into connecting: %q", *got.LoginURL)
	}

	if err := s.SetConnected("localcast.tail1234.ts.net", "", protocol.Ptr(int64(1788000000000))); err != nil {
		t.Fatal(err)
	}
	got := s.Get()
	if got.Host == nil || *got.Host != "localcast.tail1234.ts.net" {
		t.Errorf("host = %v", got.Host)
	}
	if got.FunnelURL != nil {
		t.Errorf("funnelUrl must be nil in tailnet mode, got %q", *got.FunnelURL)
	}
	if got.CertExpiresAt == nil {
		t.Error("certExpiresAt dropped")
	}

	if err := s.SetError(protocol.ErrCodeEdgeCertUnavailable, "the tailnet has HTTPS disabled"); err != nil {
		t.Fatal(err)
	}
	got = s.Get()
	if got.ErrorCode == nil || *got.ErrorCode != protocol.ErrCodeEdgeCertUnavailable {
		t.Errorf("errorCode = %v", got.ErrorCode)
	}
	if got.ErrorMessage == nil {
		t.Error("errorMessage missing")
	}
	// The host stays: "error" does not mean "we forgot the address", and the settings page
	// still wants to show which node failed.
	if got.Host == nil {
		t.Error("host was cleared on error")
	}

	if err := s.SetStarting(); err != nil {
		t.Fatal(err)
	}
	got = s.Get()
	if got.ErrorCode != nil || got.ErrorMessage != nil {
		t.Errorf("a stale error survived a restart: %v %v", got.ErrorCode, got.ErrorMessage)
	}
	if got.Host != nil || got.CertExpiresAt != nil || got.Peers != 0 {
		t.Errorf("a restart must forget the old generation's identity: %+v", got)
	}
}

func TestFunnelURLPublished(t *testing.T) {
	s := NewStatusStore(fixedClock())
	mustAll(t, s.SetStarting(), s.SetConnecting(), s.SetObtainingCertificate())

	if err := s.SetConnected("localcast.tail1234.ts.net", "https://localcast.tail1234.ts.net", nil); err != nil {
		t.Fatal(err)
	}
	got := s.Get()
	if got.FunnelURL == nil || *got.FunnelURL != "https://localcast.tail1234.ts.net" {
		t.Errorf("funnelUrl = %v", got.FunnelURL)
	}
}

func TestUpdateKeepsState(t *testing.T) {
	s := NewStatusStore(fixedClock())
	mustAll(t, s.SetStarting(), s.SetConnecting())

	before := s.Get()
	s.SetPeers(4)
	after := s.Get()

	if after.State != before.State {
		t.Errorf("Update changed the state from %q to %q", before.State, after.State)
	}
	if after.Peers != 4 {
		t.Errorf("peers = %d", after.Peers)
	}
	if after.UpdatedAt <= before.UpdatedAt {
		t.Error("Update must re-stamp UpdatedAt so subscribers can order snapshots")
	}
}

// TestNoOpUpdatesAreNotPublished: the watcher polls every thirty seconds for the life of the
// process, and a stable connected node must not emit a status line twice a minute for ever.
func TestNoOpUpdatesAreNotPublished(t *testing.T) {
	s := NewStatusStore(fixedClock())
	ch, cancel := s.Subscribe()
	defer cancel()

	mustAll(t, s.SetStarting(), s.SetConnecting())
	drain(ch)

	s.SetPeers(0) // already zero
	s.SetCertExpiry(nil)
	if got := len(ch); got != 0 {
		t.Errorf("%d snapshots published for no change", got)
	}

	s.SetPeers(3)
	expiry := int64(1788000000000)
	s.SetCertExpiry(&expiry)
	if got := len(ch); got != 2 {
		t.Errorf("%d snapshots published for two changes, want 2", got)
	}
	drain(ch)

	// A fresh pointer holding the same value is not a change.
	same := int64(1788000000000)
	s.SetCertExpiry(&same)
	s.SetPeers(3)
	if got := len(ch); got != 0 {
		t.Errorf("%d snapshots published for a repeated value", got)
	}
}

func drain(ch <-chan protocol.EdgeStatus) {
	for {
		select {
		case <-ch:
		default:
			return
		}
	}
}

func TestSubscribeReceivesEveryTransition(t *testing.T) {
	s := NewStatusStore(fixedClock())
	ch, cancel := s.Subscribe()
	defer cancel()

	mustAll(t, s.SetStarting(), s.SetConnecting())

	want := []protocol.EdgeState{protocol.StateStarting, protocol.StateConnecting}
	for _, w := range want {
		select {
		case got := <-ch:
			if got.State != w {
				t.Errorf("received %q, want %q", got.State, w)
			}
		case <-time.After(time.Second):
			t.Fatalf("no snapshot for %q", w)
		}
	}
}

// TestSubscriberBackpressure: a subscriber that stops reading must not wedge the tsnet
// goroutines. The store coalesces instead, so the slow reader still ends up with the truth.
func TestSubscriberBackpressure(t *testing.T) {
	s := NewStatusStore(fixedClock())
	ch, cancel := s.Subscribe()
	defer cancel()

	if err := s.SetStarting(); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < subscriberBuffer*4; i++ {
		s.SetPeers(i)
	}

	// Drain and check the last snapshot is the newest one, not an ancient one.
	var last protocol.EdgeStatus
	for {
		select {
		case v := <-ch:
			last = v
			continue
		default:
		}
		break
	}
	if last.Peers != subscriberBuffer*4-1 {
		t.Errorf("last delivered peers = %d, want the newest value %d", last.Peers, subscriberBuffer*4-1)
	}
}

func TestUnsubscribeClosesAndIsIdempotent(t *testing.T) {
	s := NewStatusStore(fixedClock())
	ch, cancel := s.Subscribe()

	cancel()
	cancel() // a double cancel must not panic on a closed channel

	select {
	case _, ok := <-ch:
		if ok {
			t.Error("channel delivered after cancel")
		}
	case <-time.After(time.Second):
		t.Error("channel was not closed by cancel")
	}

	// Publishing after the last subscriber left must not panic.
	if err := s.SetStarting(); err != nil {
		t.Fatal(err)
	}
}

func mustAll(t *testing.T, errs ...error) {
	t.Helper()
	for _, err := range errs {
		if err != nil {
			t.Fatal(err)
		}
	}
}
