package edge

// Design spec 2.4 claims that moving between Tailscale's coordination server and a personal
// Headscale needs neither a reinstall nor a restart, and that nothing the user cares about is
// lost on the way. Until this file existed the claim rested entirely on reading Apply.
//
// These tests drive a **real tsnet node** — the same one production runs — against a local
// HTTP server standing in for a coordination server. That stand-in is not a control plane: it
// answers the first request of the handshake (`GET /key`) and refuses it, which is enough to
// get tsnet through Start, into its authentication loop and talking to the URL it was
// configured with, and therefore enough to exercise every part of the switch machinery. It is
// not enough to reach ipn.Running.
//
// So what is demonstrated here is: the switch happens inside one process, the previous node is
// destroyed, the new one talks to the new URL, each control server keeps its own tsnet
// identity across a round trip, and the published status tells the truth throughout. What is
// *not* demonstrated, because it needs a control plane that can actually register a node, is
// traffic continuing to flow to the new tailnet after the switch. Any test asserting that
// against this stand-in would be proving only the stand-in.

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"tailscale.com/ipn"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

const (
	// settle is how long a generation is left alone before it is measured. tsnet reaches its
	// authentication loop in well under a tenth of a second; this is generous enough that the
	// stand-in control server has been asked for its key several times over, which is what the
	// "is this node still talking to that URL?" assertions count.
	settle = 1200 * time.Millisecond

	// quiet is how long a control server is watched for traffic that should no longer arrive.
	// It is calibrated inside the test rather than assumed: an assertion that the old server
	// went quiet is only worth making if the *new* one was hit repeatedly in the same window.
	quiet = 1200 * time.Millisecond
)

// magicsockPortRe matches the line tsnet logs when its WireGuard socket takes a host UDP port.
// That port is the one concrete, externally visible resource a generation holds on this
// machine, which makes it the honest answer to "was the old listener released?".
var magicsockPortRe = regexp.MustCompile(`onPortUpdate\(port=(\d+), network=(udp4|udp6)\)`)

// ─── stand-in control server ─────────────────────────────────────────────────

// fakeControl is an HTTP server in the shape a coordination server presents to a starting
// node: tsnet's first move is GET /key, and both Tailscale's control plane and Headscale
// answer it. This one refuses, predictably and for ever, so the node stays in its
// authentication loop and keeps addressing the URL it was given.
type fakeControl struct {
	*httptest.Server

	mu   sync.Mutex
	hits int
}

func newFakeControl(t *testing.T) *fakeControl {
	t.Helper()
	fc := &fakeControl{}
	fc.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		fc.mu.Lock()
		fc.hits++
		fc.mu.Unlock()
		// A refusal rather than a hang: a node that is being switched away from must be seen
		// to stop trying, and a hung request would make "no further hits" ambiguous.
		w.WriteHeader(http.StatusNotFound)
	}))
	t.Cleanup(fc.Close)
	return fc
}

func (f *fakeControl) count() int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits
}

// awaitTraffic waits until the node has addressed this server at least n more times than the
// mark, and fails if it never does.
func (f *fakeControl) awaitTraffic(t *testing.T, mark, n int) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if f.count()-mark >= n {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("%s was addressed %d times, want at least %d more than %d",
		f.URL, f.count(), n, mark)
}

// ─── harness ─────────────────────────────────────────────────────────────────

// switchHarness is one Edge, its status store and the log-derived facts the assertions need.
type switchHarness struct {
	edge  *Edge
	store *StatusStore

	mu    sync.Mutex
	ports map[string]int
	// states is the deduplicated sequence of published states, i.e. what an SSE subscriber
	// following /edge/status/stream would render.
	states []protocol.EdgeState
}

// headscaleConfig is the shape a self-hosted control server has to be given: custom mode,
// tailnet-only and external-proxy, because Validate refuses Funnel and control-plane
// certificates there (spec 2.3). external-proxy also keeps the certificate out of the picture
// entirely, so these tests measure the switch and not an ACME client.
func headscaleConfig(controlURL string) protocol.NetworkConfig {
	cfg := protocol.NetworkConfig{
		Mode:         protocol.ModeCustom,
		ControlURL:   controlURL,
		Expose:       protocol.ExposeTailnet,
		CertStrategy: protocol.CertExternalProxy,
		CertDomain:   "localcast.example.test",
		Hostname:     "localcast",
	}
	cfg.ApplyDefaults()
	return cfg
}

func newSwitchHarness(t *testing.T, cfg protocol.NetworkConfig, stateDir string) *switchHarness {
	t.Helper()

	h := &switchHarness{store: NewStatusStore(nil), ports: map[string]int{}}

	ch, unsubscribe := h.store.Subscribe()
	recorded := make(chan struct{})
	go func() {
		defer close(recorded)
		for st := range ch {
			h.mu.Lock()
			// Deduplicated: commitLocked republishes on every write, and a run of identical
			// states carries no news to a subscriber.
			if n := len(h.states); n == 0 || h.states[n-1] != st.State {
				h.states = append(h.states, st.State)
			}
			h.mu.Unlock()
		}
	}()

	e, err := New(cfg, Options{
		Upstream:     "127.0.0.1:9",
		SharedSecret: "test-secret",
		StateDir:     stateDir,
		Status:       h.store,
		Logf: func(_ protocol.LogLevel, format string, args ...any) {
			if !strings.Contains(format, "onPortUpdate") {
				return
			}
			if m := magicsockPortRe.FindStringSubmatch(fmt.Sprintf(format, args...)); m != nil {
				h.mu.Lock()
				h.ports[m[2]], _ = parseInt(m[1])
				h.mu.Unlock()
			}
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	h.edge = e

	t.Cleanup(func() {
		e.Stop()
		unsubscribe()
		<-recorded
	})
	return h
}

func parseInt(s string) (int, error) {
	var n int
	_, err := fmt.Sscanf(s, "%d", &n)
	return n, err
}

func (h *switchHarness) udpPort() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.ports["udp4"]
}

func (h *switchHarness) sequence() []protocol.EdgeState {
	h.mu.Lock()
	defer h.mu.Unlock()
	return append([]protocol.EdgeState(nil), h.states...)
}

// bindable reports whether a host UDP port can be taken, i.e. whether whoever held it let go.
func bindable(port int) error {
	c, err := net.ListenPacket("udp4", fmt.Sprintf(":%d", port))
	if err != nil {
		return err
	}
	return c.Close()
}

// awaitGoroutines waits for the goroutine count to come back down to want+slack. tsnet's
// shutdown is not instantaneous, so this polls rather than sampling once.
func awaitGoroutines(t *testing.T, want, slack int) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	var got int
	for time.Now().Before(deadline) {
		got = runtime.NumGoroutine()
		if got <= want+slack {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	buf := make([]byte, 1<<16)
	buf = buf[:runtime.Stack(buf, true)]
	t.Fatalf("%d goroutines are still running, want at most %d\n%s", got, want+slack, buf)
}

// ─── the switch itself ───────────────────────────────────────────────────────

// TestSwitchingControlServersHappensInsideOneProcess is the headline claim of spec 2.4.
//
// It moves a live tsnet node from one coordination server to another and back, and checks the
// only evidence that settles the question: which URL the node is actually addressing. The
// process assertions are what a unit test can honestly say — Apply returns, the same Edge goes
// on serving, and the pid does not change — and the reason they are enough is structural:
// nothing outside cmd/netedge calls os.Exit, and Apply spawns nothing.
func TestSwitchingControlServersHappensInsideOneProcess(t *testing.T) {
	tailscale := newFakeControl(t) // stands in for controlplane.tailscale.com
	headscale := newFakeControl(t) // stands in for the user's own server

	pid := os.Getpid()
	h := newSwitchHarness(t, headscaleConfig(tailscale.URL), t.TempDir())

	if err := h.edge.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	tailscale.awaitTraffic(t, 0, 2)

	// ── switch to the personal Headscale ──
	beforeSwitch := tailscale.count()
	if err := h.edge.Apply(headscaleConfig(headscale.URL)); err != nil {
		t.Fatalf("Apply(headscale): %v", err)
	}
	if got := h.edge.Config().ControlURL; got != headscale.URL {
		t.Errorf("controlUrl after the switch = %q, want %q", got, headscale.URL)
	}

	// The new server has to be busy before the old one's silence means anything: the window
	// calibrates itself, so this cannot pass merely because nothing happened in either.
	headscale.awaitTraffic(t, 0, 2)
	time.Sleep(quiet)
	if extra := tailscale.count() - beforeSwitch; extra != 0 {
		t.Errorf("the previous coordination server was addressed %d more times after the switch, want 0", extra)
	}

	// ── and back again ──
	beforeBack := headscale.count()
	markTailscale := tailscale.count()
	if err := h.edge.Apply(headscaleConfig(tailscale.URL)); err != nil {
		t.Fatalf("Apply(back to tailscale): %v", err)
	}
	tailscale.awaitTraffic(t, markTailscale, 2)
	time.Sleep(quiet)
	if extra := headscale.count() - beforeBack; extra != 0 {
		t.Errorf("the Headscale server was addressed %d more times after switching back, want 0", extra)
	}
	if got := h.edge.Config().ControlURL; got != tailscale.URL {
		t.Errorf("controlUrl after switching back = %q, want %q", got, tailscale.URL)
	}

	if os.Getpid() != pid {
		t.Fatalf("the process changed identity across the switch: %d -> %d", pid, os.Getpid())
	}
}

// TestSwitchingTearsTheOldNodeDown checks that the generation left behind is actually gone
// rather than merely dereferenced: its bring-up goroutine has returned, its local API is
// closed, and the host UDP port its WireGuard socket held has been given back.
//
// The port is the load-bearing assertion. It is a real socket on this machine, and the test
// first proves the port cannot be taken while the node is up, so "it can be taken now" is
// evidence and not a tautology.
func TestSwitchingTearsTheOldNodeDown(t *testing.T) {
	first := newFakeControl(t)
	second := newFakeControl(t)

	h := newSwitchHarness(t, headscaleConfig(first.URL), t.TempDir())
	if err := h.edge.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	first.awaitTraffic(t, 0, 2)

	old := h.edge.current()
	if old == nil {
		t.Fatal("no instance is running after Start")
	}
	port := h.udpPort()
	if port == 0 {
		t.Fatal("tsnet never reported a magicsock UDP port; the log hook needs updating")
	}
	if err := bindable(port); err == nil {
		t.Fatalf("UDP port %d was free while the node was supposed to be holding it", port)
	}

	if err := h.edge.Apply(headscaleConfig(second.URL)); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	select {
	case <-old.done:
	default:
		t.Error("the previous generation's bring-up goroutine was still running when Apply returned")
	}
	if _, err := old.lc.Status(context.Background()); err == nil {
		t.Error("the previous generation's local Tailscale client still answers; the node was not closed")
	}
	if h.edge.current() == old {
		t.Error("Edge is still holding the previous generation")
	}
	// tsnet.Server.Listen is deliberately not used as a liveness signal here. It re-enters
	// Server.Start, which is behind a sync.Once, and then registers into a map, so it returns
	// a listener without error on a server that has been closed — the listener simply never
	// accepts anything. That says nothing about whether the node was torn down; the local API
	// and the host UDP port do.

	// The socket is released by tsnet's own shutdown, which is asynchronous.
	deadline := time.Now().Add(10 * time.Second)
	var bindErr error
	for time.Now().Before(deadline) {
		if bindErr = bindable(port); bindErr == nil {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if bindErr != nil {
		t.Errorf("UDP port %d is still held after the switch: %v", port, bindErr)
	}
	if now := h.udpPort(); now == port {
		t.Errorf("the new generation reused port %d; it should have taken its own", port)
	}
}

// TestSwitchingBackRestoresTheFirstConfiguration is the half of spec 2.4 about *changing your
// mind*. Each control plane keeps its own tsnet state directory, so the node key Tailscale
// issued is still there after a trip through Headscale and back — which is the difference
// between "switch back" and "sign in again".
func TestSwitchingBackRestoresTheFirstConfiguration(t *testing.T) {
	first := newFakeControl(t)
	second := newFakeControl(t)
	stateDir := t.TempDir()

	h := newSwitchHarness(t, headscaleConfig(first.URL), stateDir)
	if err := h.edge.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	first.awaitTraffic(t, 0, 2)

	firstState := filepath.Join(stateDir, "tsnet", "custom-"+sanitizeDirKey(first.URL), "tailscaled.state")
	before, err := os.ReadFile(firstState)
	if err != nil {
		t.Fatalf("the first generation wrote no tsnet state: %v", err)
	}
	if len(before) == 0 {
		t.Fatal("the first generation's tsnet state is empty")
	}

	if err := h.edge.Apply(headscaleConfig(second.URL)); err != nil {
		t.Fatalf("Apply(second): %v", err)
	}
	second.awaitTraffic(t, 0, 2)

	secondState := filepath.Join(stateDir, "tsnet", "custom-"+sanitizeDirKey(second.URL), "tailscaled.state")
	if _, err := os.Stat(secondState); err != nil {
		t.Fatalf("the second control server did not get a state directory of its own: %v", err)
	}

	mark := first.count()
	if err := h.edge.Apply(headscaleConfig(first.URL)); err != nil {
		t.Fatalf("Apply(back to first): %v", err)
	}
	first.awaitTraffic(t, mark, 2)

	after, err := os.ReadFile(firstState)
	if err != nil {
		t.Fatalf("the first control server's tsnet state disappeared: %v", err)
	}
	if sha256.Sum256(before) != sha256.Sum256(after) {
		t.Errorf("the first control server's tsnet identity changed across the round trip:\n  before %s\n  after  %s",
			hex.EncodeToString(sum8(before)), hex.EncodeToString(sum8(after)))
	}
	if got := h.edge.Config(); got.ControlURL != first.URL || got.Mode != protocol.ModeCustom {
		t.Errorf("configuration after switching back = %s, want the first one", got)
	}
}

func sum8(b []byte) []byte {
	s := sha256.Sum256(b)
	return s[:8]
}

// TestSwitchStatusStreamReportsTheTransition: the tray and the settings page follow the status
// stream, so a switch has to look like one. Every generation must be announced as `starting`
// before anything else, and nothing may claim `connected` — these nodes never authenticate,
// and a stream that said otherwise would be inventing it.
func TestSwitchStatusStreamReportsTheTransition(t *testing.T) {
	first := newFakeControl(t)
	second := newFakeControl(t)

	h := newSwitchHarness(t, headscaleConfig(first.URL), t.TempDir())
	if err := h.edge.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	first.awaitTraffic(t, 0, 2)
	if err := h.edge.Apply(headscaleConfig(second.URL)); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	second.awaitTraffic(t, 0, 2)
	if err := h.edge.Apply(headscaleConfig(first.URL)); err != nil {
		t.Fatalf("Apply(back): %v", err)
	}
	first.awaitTraffic(t, first.count(), 2)
	time.Sleep(settle)

	seq := h.sequence()
	t.Logf("published states: %v", seq)

	var starts int
	for i, st := range seq {
		switch st {
		case protocol.StateStarting:
			starts++
		case protocol.StateConnecting:
			if i == 0 || seq[i-1] != protocol.StateStarting {
				t.Errorf("connecting at position %d was not preceded by starting: %v", i, seq)
			}
		case protocol.StateConnected:
			t.Errorf("the stream reported connected at position %d, but no node ever authenticated: %v", i, seq)
		}
	}
	if starts != 3 {
		t.Errorf("%d generations were announced as starting, want 3 (one per Start/Apply): %v", starts, seq)
	}
	if final := h.store.Get(); final.State != protocol.StateConnecting {
		t.Errorf("final state = %q, want connecting", final.State)
	}
}

// ─── the window a switch opens ───────────────────────────────────────────────

// wedgedInstance is a generation whose bring-up goroutine never finishes: what replace sees
// when a DNS-01 issuance is in flight, since that can hold bringUp for dns01Timeout — forty
// times the wait instance.stop is allowed. Mistyping a domain and correcting it lands exactly
// here.
//
// It returns the instance, the context its teardown cancels, and the Edge it is installed in.
func wedgedInstance(t *testing.T, e *Edge, store *StatusStore) (*instance, context.Context) {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	inst := &instance{cancel: cancel, done: make(chan struct{}), gen: e.gen, login: newLoginPublisher(store, nil)}
	inst.login.commit = func(write func() error) bool { return e.publish(inst.gen, write) }
	e.inst = inst
	t.Cleanup(cancel)
	return inst, ctx
}

// connectedStore returns a store parked exactly where a healthy node leaves it.
func connectedStore(t *testing.T, host string) *StatusStore {
	t.Helper()
	s := NewStatusStore(nil)
	mustAll(t, s.SetStarting(), s.SetConnecting())
	if err := s.SetConnected(host, "", nil); err != nil {
		t.Fatal(err)
	}
	return s
}

// TestSwitchPublishesStartingBeforeTearingTheOldNodeDown is a regression test.
//
// Measured before the fix: two seconds into a fifteen-second teardown the published status
// still read `connected`, with the previous tailnet's address in it, for a node whose context
// had already been cancelled. The user had pressed Save; the tray showed a green dot and an
// address that had stopped working. replace now says what it is doing before it does it.
func TestSwitchPublishesStartingBeforeTearingTheOldNodeDown(t *testing.T) {
	const oldHost = "localcast.tail1234.ts.net"
	control := newFakeControl(t)

	store := connectedStore(t, oldHost)
	e, err := New(headscaleConfig(control.URL), Options{
		Upstream: "127.0.0.1:9", SharedSecret: "test-secret", StateDir: t.TempDir(), Status: store,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Stop)
	// Long enough that the teardown is unambiguously still in progress when the status is
	// read, short enough that the test does not spend shutdownTimeout doing it.
	e.shutdownWait = 3 * time.Second

	_, torn := wedgedInstance(t, e, store)

	observed := make(chan protocol.EdgeStatus, 1)
	go func() {
		// The teardown begins when instance.stop cancels the generation.
		<-torn.Done()
		time.Sleep(300 * time.Millisecond)
		observed <- store.Get()
	}()

	if err := e.Apply(headscaleConfig(control.URL)); err != nil {
		t.Fatalf("Apply: %v", err)
	}

	during := <-observed
	if during.State != protocol.StateStarting {
		t.Errorf("state during the teardown = %q, want starting: the node was already cancelled", during.State)
	}
	if during.Host != nil {
		t.Errorf("the previous tailnet's address %q was still published during the teardown", *during.Host)
	}
}

// TestAbandonedBringUpCannotPublishAfterTheSwitch is a regression test.
//
// instance.stop waits a bounded time for the bring-up goroutine; a DNS-01 issuance can hold it
// far longer, and replace carries on regardless. Measured before the fix: the abandoned
// goroutine's closing SetConnected was accepted, so the published status ended up `connected`
// on the *previous* tailnet's host while the new generation was still connecting — the tray
// lying in the one direction that matters, about a node that no longer exists.
//
// The abandoned goroutine here is the test's, not bringUp's: reaching bringUp's tail needs a
// control plane that can register a node and, for the long window, a real ACME issuance.
// What it does is what bringUp does — publish on behalf of its own generation — and the guard
// it meets is the production one.
func TestAbandonedBringUpCannotPublishAfterTheSwitch(t *testing.T) {
	const (
		oldHost  = "localcast.tail1234.ts.net"
		oldLogin = "https://login.tailscale.com/a/16fe082601b32f"
	)
	control := newFakeControl(t)

	store := connectedStore(t, oldHost)
	e, err := New(headscaleConfig(control.URL), Options{
		Upstream: "127.0.0.1:9", SharedSecret: "test-secret", StateDir: t.TempDir(), Status: store,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(e.Stop)
	e.shutdownWait = 150 * time.Millisecond

	old, torn := wedgedInstance(t, e, store)

	resume := make(chan struct{})
	finished := make(chan struct{})
	go func() {
		defer close(finished)
		<-torn.Done()
		<-resume // the switch has completed; now finish the work nobody is waiting for
		e.publish(old.gen, func() error { e.opts.Status.SetHost(oldHost); return nil })
		e.publish(old.gen, func() error { return e.opts.Status.SetConnected(oldHost, "", nil) })
		old.login.publish(oldLogin)
	}()

	if err := e.Apply(headscaleConfig(control.URL)); err != nil {
		t.Fatalf("Apply: %v", err)
	}
	close(resume)
	<-finished

	got := store.Get()
	if got.State == protocol.StateConnected {
		t.Errorf("a generation that had been replaced published connected; state = %q host = %v",
			got.State, derefString(got.Host))
	}
	if got.Host != nil && *got.Host == oldHost {
		t.Errorf("the previous tailnet's address %q was republished after the switch", oldHost)
	}
	if got.LoginURL != nil && *got.LoginURL == oldLogin {
		t.Error("a sign-in link for the control server the user had just left was published after the switch")
	}
}

// TestWatchOfAReplacedGenerationIsSilent runs the production watch loop for a generation that
// has been retired, with a daemon reporting the state that normally forces a publish. Nothing
// may reach the store: watch has no deadline and outlives its own instance by design, so it is
// the other way an abandoned generation can talk over its successor.
func TestWatchOfAReplacedGenerationIsSilent(t *testing.T) {
	store := connectedStore(t, "localcast.tail1234.ts.net")

	e, err := New(headscaleConfig("https://headscale.example.test"), Options{
		Upstream: "127.0.0.1:9", SharedSecret: "test-secret", StateDir: t.TempDir(), Status: store,
	})
	if err != nil {
		t.Fatal(err)
	}

	lc := &fakeLocalClient{backendState: ipn.Running.String()}
	inst := &instance{lc: lc, login: newLoginPublisher(store, nil), done: make(chan struct{}), gen: e.gen}
	inst.login.commit = func(write func() error) bool { return e.publish(inst.gen, write) }

	// The user changed the configuration: this generation is no longer the one being run.
	e.retire()

	ch, unsubscribe := store.Subscribe()
	defer unsubscribe()

	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		e.watch(ctx, inst, connectedIdentity{host: "localcast.tail1234.ts.net"}, watchTick)
	}()
	defer func() {
		cancel()
		<-stopped
	}()

	// The key expired under the retired node — normally the loudest event watch has.
	lc.set(ipn.NeedsLogin.String(), "https://login.tailscale.com/a/16fe082601b32f")
	time.Sleep(watchSettle)

	if n := len(ch); n != 0 {
		t.Errorf("a retired generation's watch published %d snapshots, want 0", n)
	}
	if got := store.Get().State; got != protocol.StateConnected {
		t.Errorf("a retired generation's watch moved the published state to %q", got)
	}
}

// ─── repetition ──────────────────────────────────────────────────────────────

// TestRepeatedApplyDoesNotLeak covers the three ways a user actually produces a burst of
// configuration changes: saving the same settings twice, correcting a value immediately, and
// changing their mind again before the previous change has settled. Every Apply is a full
// teardown and rebuild — that is deliberate, since re-saving is also how a user retries a node
// stuck in `error` — so the thing to check is that nothing accumulates.
func TestRepeatedApplyDoesNotLeak(t *testing.T) {
	first := newFakeControl(t)
	second := newFakeControl(t)

	baseline := runtime.NumGoroutine()
	h := newSwitchHarness(t, headscaleConfig(first.URL), t.TempDir())
	if err := h.edge.Start(context.Background()); err != nil {
		t.Fatalf("Start: %v", err)
	}
	first.awaitTraffic(t, 0, 2)
	oneGeneration := runtime.NumGoroutine() - baseline
	if oneGeneration <= 0 {
		t.Fatalf("a running tsnet node accounts for %d goroutines; the measurement is wrong", oneGeneration)
	}
	t.Logf("one tsnet generation = %d goroutines", oneGeneration)

	// The same configuration, twice. Nothing changed, so nothing may be left behind either.
	for i := range 2 {
		if err := h.edge.Apply(headscaleConfig(first.URL)); err != nil {
			t.Fatalf("re-applying the same configuration (%d): %v", i, err)
		}
	}

	// Back-to-back changes, each one landing while the previous generation is still in its
	// authentication loop and has published nothing but `connecting`.
	for i := range 6 {
		target := first
		if i%2 == 0 {
			target = second
		}
		if err := h.edge.Apply(headscaleConfig(target.URL)); err != nil {
			t.Fatalf("Apply %d: %v", i, err)
		}
	}

	// Two generations' worth is the failure threshold: it is what an Apply that failed to tear
	// its predecessor down would produce, and nine of them would be unmissable.
	awaitGoroutines(t, baseline+oneGeneration, oneGeneration)

	if got := h.edge.Config().ControlURL; got != first.URL {
		t.Errorf("controlUrl after the burst = %q, want the last one applied %q", got, first.URL)
	}
	if st := h.store.Get().State; st != protocol.StateConnecting && st != protocol.StateStarting {
		t.Errorf("state after the burst = %q, want starting or connecting", st)
	}

	// And the whole tree unwinds on Stop: this is the leak check with nothing left to excuse it.
	h.edge.Stop()
	awaitGoroutines(t, baseline, 5)
	if got := h.store.Get().State; got != protocol.StateStopped {
		t.Errorf("state after Stop = %q, want stopped", got)
	}
}

// TestStateDirectoryKeysSurviveLongControlURLs is a regression test.
//
// The key was truncated at 64 characters with nothing to disambiguate it, so two Headscale
// deployments differing only past the cut — the same host behind different path prefixes is an
// ordinary reverse-proxy layout — shared one tsnet state directory. A state file holds a node
// key that means nothing to the other control server, so switching would silently re-register
// the machine and switching back would demand a fresh sign-in: precisely the promise spec 2.4
// makes.
func TestStateDirectoryKeysSurviveLongControlURLs(t *testing.T) {
	const prefix = "https://headscale.internal.example-corporation.test/tenants/engineering/"
	a := sanitizeDirKey(prefix + "alpha")
	b := sanitizeDirKey(prefix + "beta")

	if a == b {
		t.Errorf("two different control servers share the state directory key %q", a)
	}
	for _, k := range []string{a, b} {
		if len(k) > maxDirKeyLen {
			t.Errorf("key %q is %d characters, over the %d cap", k, len(k), maxDirKeyLen)
		}
		if strings.ContainsAny(k, `/\:?*"<>|`) {
			t.Errorf("key %q contains a character Windows will not accept in a path component", k)
		}
	}

	// A URL short enough not to be truncated keeps the name it already has on disk. Adding a
	// digest to every key would orphan the state of every working deployment at the next
	// upgrade, which is the same failure by another route.
	if got := sanitizeDirKey("https://headscale.example.test"); got != "headscale.example.test" {
		t.Errorf("short control URLs must keep their existing directory name; got %q", got)
	}

	// http and https on one host are one control server, and deliberately share their state:
	// a user who adds TLS in front of their Headscale should not have to sign in again.
	if sanitizeDirKey("http://hs.example.test") != sanitizeDirKey("https://hs.example.test") {
		t.Error("switching a control URL between http and https must not discard the node's identity")
	}
}

func derefString(s *string) string {
	if s == nil {
		return "<none>"
	}
	return *s
}
