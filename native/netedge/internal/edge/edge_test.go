package edge

import (
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

// watchTick is the poll interval the watch tests drive the loop at. watch takes the interval
// as a parameter precisely so these tests do not have to wait peerPollInterval per iteration.
const watchTick = time.Millisecond

// watchSettle is how long a test that asserts *nothing* happens lets the loop run. At
// watchTick that is a few hundred polls, which is a far harder test of the no-op paths than a
// single call would be.
const watchSettle = 200 * time.Millisecond

// fakeLocalClient is the slice of tsnet's LocalClient that watch touches, driven by the test.
// It locks because watch calls Status from its own goroutine while the test flips the state.
type fakeLocalClient struct {
	mu           sync.Mutex
	backendState string
	authURL      string
	logins       int
}

// The assignment is the compile-time check that the fake still satisfies the interface watch
// is written against.
var _ localClient = (*fakeLocalClient)(nil)

func (f *fakeLocalClient) set(backendState, authURL string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.backendState = backendState
	f.authURL = authURL
}

func (f *fakeLocalClient) loginCalls() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.logins
}

func (f *fakeLocalClient) Status(context.Context) (*ipnstate.Status, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return &ipnstate.Status{BackendState: f.backendState, AuthURL: f.authURL}, nil
}

func (f *fakeLocalClient) StartLoginInteractive(context.Context) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.logins++
	return nil
}

// The remaining three are on the interface but not on any path watch takes; failing loudly
// means a future change that starts calling one is not silently given a plausible answer.
func (f *fakeLocalClient) CertPair(context.Context, string) ([]byte, []byte, error) {
	return nil, nil, errors.New("CertPair is not part of the watch path")
}

func (f *fakeLocalClient) WhoIs(context.Context, string) (*apitype.WhoIsResponse, error) {
	return nil, errors.New("WhoIs is not part of the watch path")
}

func (f *fakeLocalClient) Logout(context.Context) error { return nil }

// startWatch puts the store where bringUp leaves it — connected — and runs watch against a
// fake daemon that starts out Running. It returns the pieces a test drives and asserts on;
// the watch goroutine is stopped when the test ends.
func startWatch(t *testing.T, id connectedIdentity) (*StatusStore, *fakeLocalClient, <-chan protocol.EdgeStatus) {
	t.Helper()

	store := NewStatusStore(fixedClock())
	mustAll(t, store.SetStarting(), store.SetConnecting())
	if err := store.SetConnected(id.host, id.funnelURL, nil); err != nil {
		t.Fatal(err)
	}

	cfg := protocol.NetworkConfig{Mode: protocol.ModeDefault, CertStrategy: protocol.CertControlPlane}
	cfg.ApplyDefaults()
	e, err := New(cfg, Options{
		Upstream:     "127.0.0.1:8080",
		SharedSecret: "test-secret",
		StateDir:     t.TempDir(),
		Status:       store,
		Now:          fixedClock(),
	})
	if err != nil {
		t.Fatal(err)
	}

	lc := &fakeLocalClient{backendState: ipn.Running.String()}
	inst := &instance{lc: lc, login: newLoginPublisher(store, nil), done: make(chan struct{})}

	ch, unsubscribe := store.Subscribe()

	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		e.watch(ctx, inst, id, watchTick)
	}()
	t.Cleanup(func() {
		cancel()
		select {
		case <-stopped:
		case <-time.After(2 * time.Second):
			t.Error("watch did not return when its context was cancelled")
		}
		unsubscribe()
	})

	return store, lc, ch
}

// awaitState waits for a snapshot in the state the test is expecting and returns it.
func awaitState(t *testing.T, ch <-chan protocol.EdgeStatus, want protocol.EdgeState) protocol.EdgeStatus {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for {
		select {
		case got, ok := <-ch:
			if !ok {
				t.Fatalf("the status stream closed before reaching %q", want)
			}
			if got.State == want {
				return got
			}
		case <-deadline:
			t.Fatalf("no %q snapshot was published", want)
		}
	}
}

// TestWatchPublishesLoginRequiredAfterConnected is the defect this poll exists for: a key that
// expires *after* the node has connected drops the backend to NeedsLogin, waitForRunning has
// long since returned, and without watch the tray would go on showing a green dot for a node
// that has stopped carrying traffic.
func TestWatchPublishesLoginRequiredAfterConnected(t *testing.T) {
	const url = "https://login.tailscale.com/a/16fe082601b32f"

	store, lc, ch := startWatch(t, connectedIdentity{host: "localcast.tail1234.ts.net"})

	lc.set(ipn.NeedsLogin.String(), url)

	got := awaitState(t, ch, protocol.StateLoginRequired)
	if got.LoginURL == nil || *got.LoginURL != url {
		t.Fatalf("loginUrl = %v, want %q", got.LoginURL, url)
	}
	if store.Get().State != protocol.StateLoginRequired {
		t.Errorf("state = %q, want login-required", store.Get().State)
	}

	// The daemon reports the same URL on every poll for as long as the user has not signed in,
	// which can be days. Exactly one of those hundreds of polls is news.
	time.Sleep(watchSettle)
	if n := len(ch); n != 0 {
		t.Errorf("%d further snapshots for an unchanged login-required state, want 0", n)
	}
	// A URL was on offer the whole time, so there was never anything to ask the control server
	// for.
	if n := lc.loginCalls(); n != 0 {
		t.Errorf("StartLoginInteractive called %d times while a URL was already published", n)
	}
}

// TestWatchIsSilentWhileNothingChanges guards the property that makes a poll this cheap
// acceptable at all: it runs for the life of the process, so a healthy connected node must
// produce neither a status event nor a state change, however many times it is polled.
func TestWatchIsSilentWhileNothingChanges(t *testing.T) {
	store, _, ch := startWatch(t, connectedIdentity{host: "localcast.tail1234.ts.net"})

	time.Sleep(watchSettle)

	if n := len(ch); n != 0 {
		t.Errorf("%d snapshots published while nothing changed, want 0", n)
	}
	if got := store.Get().State; got != protocol.StateConnected {
		t.Errorf("state = %q, want connected", got)
	}
}

// TestWatchRestoresConnectedOnRecovery: signing in again must take the tray back to green,
// with the consumed login URL gone and the address it was serving on restored. Nothing else
// in the process would do it — the bring-up goroutine finished when the node first connected.
func TestWatchRestoresConnectedOnRecovery(t *testing.T) {
	const (
		url  = "https://login.tailscale.com/a/16fe082601b32f"
		host = "localcast.tail1234.ts.net"
	)
	id := connectedIdentity{host: host, funnelURL: "https://" + host}

	store, lc, ch := startWatch(t, id)

	lc.set(ipn.NeedsLogin.String(), url)
	if got := awaitState(t, ch, protocol.StateLoginRequired); got.LoginURL == nil {
		t.Fatalf("the login URL was not published: %+v", got)
	}

	lc.set(ipn.Running.String(), "")

	got := awaitState(t, ch, protocol.StateConnected)
	if got.LoginURL != nil {
		t.Errorf("a consumed login URL survived the recovery: %q", *got.LoginURL)
	}
	if got.Host == nil || *got.Host != host {
		t.Errorf("host = %v, want %q", got.Host, host)
	}
	if got.FunnelURL == nil || *got.FunnelURL != id.funnelURL {
		t.Errorf("funnelUrl = %v, want %q", got.FunnelURL, id.funnelURL)
	}
	if final := store.Get(); final.State != protocol.StateConnected {
		t.Errorf("state = %q, want connected", final.State)
	}

	// Recovery is one event, not one per poll.
	time.Sleep(watchSettle)
	if n := len(ch); n != 0 {
		t.Errorf("%d further snapshots after the recovery, want 0", n)
	}
}

// TestWatchAsksForALinkWhenTheDaemonOffersNone: an expiry that leaves the daemon in NeedsLogin
// with no AuthURL still has to reach the tray — first as the honest state, then as a link to
// open. The nudge waits a poll (see authEpisode.sawNoURL) and then happens exactly once,
// however long the user leaves the prompt on screen.
func TestWatchAsksForALinkWhenTheDaemonOffersNone(t *testing.T) {
	store, lc, ch := startWatch(t, connectedIdentity{host: "localcast.tail1234.ts.net"})

	lc.set(ipn.NeedsLogin.String(), "")

	got := awaitState(t, ch, protocol.StateLoginRequired)
	if got.LoginURL != nil {
		t.Errorf("loginUrl = %q, want none: the daemon had no URL to offer", *got.LoginURL)
	}

	time.Sleep(watchSettle)
	if n := lc.loginCalls(); n != 1 {
		t.Errorf("StartLoginInteractive called %d times over ~%d polls, want exactly 1",
			n, watchSettle/watchTick)
	}
	if n := len(ch); n != 0 {
		t.Errorf("%d further snapshots while the node waited for a sign-in, want 0", n)
	}
	if got := store.Get().State; got != protocol.StateLoginRequired {
		t.Errorf("state = %q, want login-required", got)
	}
}
