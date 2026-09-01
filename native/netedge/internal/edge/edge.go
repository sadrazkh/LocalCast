// Package edge owns the tsnet node: its lifecycle, its TLS termination and the reverse
// proxy that fronts the loopback Node server.
//
// The single most important property here is that changing the network configuration
// replaces the tsnet server **inside the running process**. Design spec 2.4 requires
// switching between Tailscale's coordination server and a personal Headscale to leave the
// database untouched and not to need a reinstall, so every path that reconfigures the node
// goes through Edge.Apply, and nothing in this package calls os.Exit.
package edge

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"tailscale.com/client/tailscale/apitype"
	"tailscale.com/ipn"
	"tailscale.com/ipn/ipnstate"
	"tailscale.com/tsnet"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

const (
	// tailnetPort is the single port netedge listens on inside the tailnet.
	//
	// It is 443 for every strategy, including external-proxy where the traffic is plain
	// HTTP. One port across all three strategies means the pairing QR code, the stored
	// pairing records and the operator's proxy configuration do not have to change when the
	// certificate strategy does.
	tailnetPort = 443

	// statusPollInterval is how often the bring-up loop asks the daemon where it is. tsnet
	// exposes an event bus too, but polling a small status struct is enough here and does
	// not tie this package to the shape of ipn.Notify.
	statusPollInterval = 500 * time.Millisecond

	// peerPollInterval is how often the connected node refreshes its peer count and
	// certificate expiry for the tray.
	peerPollInterval = 30 * time.Second

	// shutdownTimeout bounds each stage of tearing a generation down, so a wedged tsnet
	// cannot stop the process from exiting or a restart from proceeding.
	shutdownTimeout = 15 * time.Second

	// loginURLWait is how long Login waits for the daemon to produce an interactive URL.
	loginURLWait = 20 * time.Second

	// loginNudgeDelay is how long the bring-up poll waits, after first seeing NeedsLogin with
	// no URL, before asking for an interactive login itself.
	//
	// tsnet.Server.Start already calls StartLoginInteractive when the node comes up without a
	// key. A second call while the first is still in flight does not help and actively hurts:
	// it restarts controlclient's auth routine, and on a real run that cancelled the pending
	// control-key fetch — `TryLogin: fetch control key: Get
	// "https://controlplane.tailscale.com/key?v=109": context canceled` — costing about five
	// seconds during which Status reports NeedsLogin with an empty AuthURL and there is
	// nothing for the sign-in button to open.
	//
	// The nudge is kept rather than deleted because tsnet only makes that call once, at start:
	// a node whose key is revoked later drops back to NeedsLogin with nobody asking on its
	// behalf. It now fires only once tsnet's own attempt has visibly produced nothing.
	loginNudgeDelay = 10 * time.Second
)

// logFunc is the logging hook every type in this package takes, so nothing writes to a
// package-level logger. main routes it to the NDJSON `log` events on stdout.
type logFunc func(level protocol.LogLevel, format string, args ...any)

// edgeError carries a stable machine code alongside the prose, so the status published to
// the tray has a code the PWA and the settings page can branch on (design spec 8).
type edgeError struct {
	code string
	msg  string
	err  error
}

func (e *edgeError) Error() string {
	if e.err != nil {
		return e.msg + ": " + e.err.Error()
	}
	return e.msg
}

func (e *edgeError) Unwrap() error { return e.err }

// codeOf extracts the machine code from err, defaulting to `internal` for errors that were
// never classified.
func codeOf(err error) string {
	var ee *edgeError
	if errors.As(err, &ee) {
		return ee.code
	}
	return protocol.ErrCodeInternal
}

// localClient is the slice of tsnet's LocalClient that netedge uses.
//
// VERIFY: the concrete type moved from tailscale.com/client/tailscale.LocalClient to
// tailscale.com/client/local.Client around tailscale v1.80. Declaring the methods as an
// interface and assigning the result of Server.LocalClient() to it means this package
// compiles against either, and a signature drift shows up as one assignment failing rather
// than as edits scattered through the file.
type localClient interface {
	Status(ctx context.Context) (*ipnstate.Status, error)
	CertPair(ctx context.Context, domain string) (certPEM, keyPEM []byte, err error)
	WhoIs(ctx context.Context, remoteAddr string) (*apitype.WhoIsResponse, error)
	StartLoginInteractive(ctx context.Context) error
	Logout(ctx context.Context) error
}

// tsWhoIs adapts a localClient to the whoIser the proxy takes, translating tailscale's wire
// types into the two fields netedge actually reads.
type tsWhoIs struct{ lc localClient }

func (t tsWhoIs) WhoIs(ctx context.Context, remoteAddr string) (*whoIsResponse, error) {
	who, err := t.lc.WhoIs(ctx, remoteAddr)
	if err != nil {
		return nil, err
	}
	if who == nil || who.Node == nil {
		return &whoIsResponse{}, nil
	}
	return &whoIsResponse{Node: &whoIsNode{
		StableID: string(who.Node.StableID),
		Name:     who.Node.Name,
	}}, nil
}

// Options configures an Edge. Everything it needs is passed in; the package holds no
// globals.
type Options struct {
	// Upstream is the host:port of the loopback Node server.
	Upstream string

	// SharedSecret is injected as x-lc-edge-secret on every proxied request.
	SharedSecret string

	// StateDir holds the tsnet node state and the ACME cache.
	StateDir string

	// Status is the store the tray and the SSE endpoint read.
	Status *StatusStore

	Logf logFunc
	Now  func() time.Time

	// TestDefaultControlURL overrides the coordination server the dry run probes. Empty in
	// production; set by tests so RunTest never touches the real internet.
	TestDefaultControlURL string
}

// Edge owns one tsnet generation at a time.
type Edge struct {
	opts Options

	mu      sync.Mutex
	cfg     protocol.NetworkConfig
	inst    *instance
	baseCtx context.Context
}

// instance is one generation of the tsnet node: the server, its listener, the HTTP server
// on top and the certificate provider behind it. Apply throws the whole struct away and
// builds another, which is why a mode switch cannot leave half of the previous
// configuration behind.
type instance struct {
	srv    *tsnet.Server
	lc     localClient
	login  *loginPublisher
	cancel context.CancelFunc
	done   chan struct{}

	// The bring-up goroutine fills these in while another goroutine may be tearing the
	// generation down, so they are behind a lock. Everything above is written once, before
	// the goroutine starts.
	mu    sync.Mutex
	certs certProvider
	http  *http.Server
}

func (i *instance) setHTTP(s *http.Server) {
	i.mu.Lock()
	i.http = s
	i.mu.Unlock()
}

func (i *instance) setCerts(c certProvider) {
	i.mu.Lock()
	i.certs = c
	i.mu.Unlock()
}

func (i *instance) parts() (*http.Server, certProvider) {
	i.mu.Lock()
	defer i.mu.Unlock()
	return i.http, i.certs
}

// New returns an Edge for cfg. cfg is validated here so a bad file on disk is refused before
// anything is started.
func New(cfg protocol.NetworkConfig, opts Options) (*Edge, error) {
	if opts.Status == nil {
		return nil, errors.New("edge: Options.Status is required")
	}
	if opts.Upstream == "" {
		return nil, errors.New("edge: Options.Upstream is required")
	}
	if opts.SharedSecret == "" {
		return nil, errors.New("edge: Options.SharedSecret is required")
	}
	if opts.StateDir == "" {
		return nil, errors.New("edge: Options.StateDir is required")
	}
	if opts.Now == nil {
		opts.Now = time.Now
	}
	if opts.Logf == nil {
		opts.Logf = func(protocol.LogLevel, string, ...any) {}
	}

	cfg.ApplyDefaults()
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	return &Edge{opts: opts, cfg: cfg, baseCtx: context.Background()}, nil
}

// Config returns the configuration currently in force, without secrets. Callers put this on
// the wire, so it must not be the live struct.
func (e *Edge) Config() protocol.NetworkConfig {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.cfg.WithoutSecrets()
}

// Start brings the first generation up.
//
// ctx is captured as the lifetime of every later generation too. That matters: Apply is
// normally called from an HTTP handler, and a handler's request context is cancelled the
// moment the response is written — using it would tear the brand-new node down before it
// finished connecting.
func (e *Edge) Start(ctx context.Context) error {
	e.mu.Lock()
	e.baseCtx = ctx
	cfg := e.cfg
	e.mu.Unlock()
	return e.replace(cfg)
}

// Apply validates cfg, tears down the running generation and brings a new one up in this
// same process.
func (e *Edge) Apply(cfg protocol.NetworkConfig) error {
	cfg.ApplyDefaults()
	if err := cfg.Validate(); err != nil {
		return err
	}
	return e.replace(cfg)
}

// Restart rebuilds the current configuration from scratch. It is the recovery path for a
// node that got stuck, and it is what POST /edge/restart calls.
func (e *Edge) Restart() error {
	e.mu.Lock()
	cfg := e.cfg
	e.mu.Unlock()
	return e.replace(cfg)
}

// Stop tears the running generation down and leaves the process alive.
func (e *Edge) Stop() {
	e.mu.Lock()
	inst := e.inst
	e.inst = nil
	e.mu.Unlock()

	if inst != nil {
		inst.stop()
	}
	if err := e.opts.Status.SetStopped(); err != nil {
		e.opts.Logf(protocol.LogWarn, "%v", err)
	}
}

// replace is the one path that swaps generations.
func (e *Edge) replace(cfg protocol.NetworkConfig) error {
	e.mu.Lock()
	defer e.mu.Unlock()

	// Down first, then up. The two generations must not both hold the tsnet state
	// directory, and in a same-mode restart they would be pointed at the same one.
	if e.inst != nil {
		e.opts.Logf(protocol.LogInfo, "stopping the current tailnet node before applying a new configuration")
		e.inst.stop()
		e.inst = nil
	}

	e.cfg = cfg
	if err := e.opts.Status.SetStarting(); err != nil {
		e.opts.Logf(protocol.LogWarn, "%v", err)
	}
	e.opts.Logf(protocol.LogInfo, "starting the tailnet node: %s", cfg.String())

	inst, err := e.launch(e.baseCtx, cfg)
	if err != nil {
		if serr := e.opts.Status.SetError(codeOf(err), err.Error()); serr != nil {
			e.opts.Logf(protocol.LogWarn, "%v", serr)
		}
		return err
	}
	e.inst = inst
	return nil
}

// launch starts the tsnet server and hands the slow part — waiting for the node to
// authenticate, fetching a certificate, opening the listener — to a goroutine, so the HTTP
// handler that triggered a mode change gets its response back immediately and the UI
// follows the status stream instead of a hanging request.
func (e *Edge) launch(ctx context.Context, cfg protocol.NetworkConfig) (*instance, error) {
	dir, err := e.tsnetDir(cfg)
	if err != nil {
		return nil, err
	}

	// One publisher per generation, shared by the status poll and by the two log hooks below,
	// so whichever of them sees the login URL first is the only one that publishes it.
	pub := newLoginPublisher(e.opts.Status, e.opts.Logf)

	srv := &tsnet.Server{
		Dir:      dir,
		Hostname: cfg.Hostname,
		// tsnet's own chatter is debug; UserLogf is the handful of lines meant for a person,
		// such as the interactive login prompt. Both are wrapped so the login URL is captured
		// from whichever of them carries it — see loginLineMarkers.
		Logf:     tsnetLogf(protocol.LogDebug, pub, e.opts.Logf),
		UserLogf: tsnetLogf(protocol.LogInfo, pub, e.opts.Logf),
	}
	if cfg.Mode == protocol.ModeCustom {
		srv.ControlURL = cfg.ControlURL
		// The auth key is in memory only. It arrived decrypted from Electron and is never
		// written to netedge's config file.
		srv.AuthKey = cfg.AuthKey
	}

	if err := srv.Start(); err != nil {
		return nil, &edgeError{code: protocol.ErrCodeEdgeControlUnreachable, msg: "could not start the tailnet node", err: err}
	}

	rawLC, err := srv.LocalClient()
	if err != nil {
		_ = srv.Close()
		return nil, &edgeError{code: protocol.ErrCodeInternal, msg: "could not open the local Tailscale client", err: err}
	}
	// The assignment is the compile-time check that tsnet's client still has the five
	// methods localClient names.
	var lc localClient = rawLC

	ictx, cancel := context.WithCancel(ctx)
	inst := &instance{srv: srv, lc: lc, login: pub, cancel: cancel, done: make(chan struct{})}

	go func() {
		defer close(inst.done)
		if err := e.bringUp(ictx, inst, cfg); err != nil {
			// A cancelled context means someone asked for this generation to go away; that
			// is not a failure to report to the user.
			if ictx.Err() != nil {
				return
			}
			e.opts.Logf(protocol.LogError, "tailnet node failed: %v", err)
			if serr := e.opts.Status.SetError(codeOf(err), err.Error()); serr != nil {
				e.opts.Logf(protocol.LogWarn, "%v", serr)
			}
		}
	}()

	return inst, nil
}

// bringUp runs the slow half of a generation's start.
func (e *Edge) bringUp(ctx context.Context, inst *instance, cfg protocol.NetworkConfig) error {
	if err := e.opts.Status.SetConnecting(); err != nil {
		e.opts.Logf(protocol.LogWarn, "%v", err)
	}

	host, err := e.waitForRunning(ctx, inst, cfg)
	if err != nil {
		return err
	}
	e.opts.Status.SetHost(host)
	e.opts.Logf(protocol.LogInfo, "tailnet node is running as %s", host)

	// Funnel terminates TLS at Tailscale's ingress with the control-plane certificate, so
	// there is nothing for a certificate provider to do on this path. Refusing funnel in
	// custom mode happens in Validate, so by here it can only be Tailscale's own.
	if cfg.Expose == protocol.ExposeFunnel {
		return e.serveFunnel(ctx, inst, host)
	}

	// external-proxy holds no certificate of its own, so announcing that one is being
	// obtained would be a lie the settings page renders verbatim.
	if cfg.CertStrategy != protocol.CertExternalProxy {
		if err := e.opts.Status.SetObtainingCertificate(); err != nil {
			e.opts.Logf(protocol.LogWarn, "%v", err)
		}
	}

	deps := certDeps{
		domain:   func() string { return certDomainFor(cfg, host) },
		cacheDir: filepath.Join(e.opts.StateDir, "certs"),
		logf:     e.opts.Logf,
		now:      e.opts.Now,
	}
	if cfg.Mode == protocol.ModeDefault {
		// Only the default coordination server can answer CertPair. Leaving this nil in
		// custom mode makes the impossible path unreachable rather than merely unused.
		deps.certPair = inst.lc.CertPair
	}

	provider, err := newCertProvider(cfg, deps)
	if err != nil {
		return err
	}
	inst.setCerts(provider)

	tlsCfg, err := provider.TLSConfig(ctx)
	if err != nil {
		return err
	}

	ln, err := inst.srv.Listen("tcp", fmt.Sprintf(":%d", tailnetPort))
	if err != nil {
		return &edgeError{
			code: protocol.ErrCodeInternal,
			msg:  fmt.Sprintf("could not listen on the tailnet address :%d", tailnetPort),
			err:  err,
		}
	}
	if tlsCfg != nil {
		ln = tls.NewListener(ln, tlsCfg)
	} else {
		e.opts.Logf(protocol.LogWarn,
			"listening without TLS on the tailnet address; the external proxy is responsible for HTTPS")
	}

	handler, err := newProxyHandler(e.opts.Upstream, e.opts.SharedSecret,
		newWhoisResolver(tsWhoIs{lc: inst.lc}, protocol.FunnelPeer, e.opts.Now), e.opts.Logf)
	if err != nil {
		_ = ln.Close()
		return &edgeError{code: protocol.ErrCodeInternal, msg: "could not build the reverse proxy", err: err}
	}

	httpSrv := newHTTPServer(handler)
	inst.setHTTP(httpSrv)
	go serve(httpSrv, ln, e.opts.Logf)

	if err := e.opts.Status.SetConnected(host, "", provider.ExpiresAt()); err != nil {
		e.opts.Logf(protocol.LogWarn, "%v", err)
	}
	go e.watch(ctx, inst)
	return nil
}

// serveFunnel publishes the node on the public internet through Tailscale Funnel.
func (e *Edge) serveFunnel(ctx context.Context, inst *instance, host string) error {
	// VERIFY: tsnet.Server.ListenFunnel(network, addr string, opts ...FunnelOption). It
	// terminates TLS itself and, without tsnet.FunnelOnly(), also serves the tailnet — which
	// is why the resolver below still asks WhoIs first and only falls back to `funnel`.
	ln, err := inst.srv.ListenFunnel("tcp", fmt.Sprintf(":%d", tailnetPort))
	if err != nil {
		return &edgeError{
			code: protocol.ErrCodeEdgeModeUnsupported,
			msg:  "could not open the Funnel listener (is Funnel enabled for this tailnet?)",
			err:  err,
		}
	}

	handler, err := newProxyHandler(e.opts.Upstream, e.opts.SharedSecret,
		newWhoisResolver(tsWhoIs{lc: inst.lc}, protocol.FunnelPeer, e.opts.Now), e.opts.Logf)
	if err != nil {
		_ = ln.Close()
		return &edgeError{code: protocol.ErrCodeInternal, msg: "could not build the reverse proxy", err: err}
	}

	httpSrv := newHTTPServer(handler)
	inst.setHTTP(httpSrv)
	go serve(httpSrv, ln, e.opts.Logf)

	funnelURL := "https://" + host
	if err := e.opts.Status.SetConnected(host, funnelURL, nil); err != nil {
		e.opts.Logf(protocol.LogWarn, "%v", err)
	}
	e.opts.Logf(protocol.LogInfo, "published on the public internet at %s", funnelURL)
	go e.watch(ctx, inst)
	return nil
}

// newHTTPServer builds the server that fronts the tailnet listener.
func newHTTPServer(h http.Handler) *http.Server {
	return &http.Server{
		Handler:           h,
		ReadHeaderTimeout: 20 * time.Second,
		// No WriteTimeout on purpose. A wall-clock write deadline would cut off a
		// multi-gigabyte download and would kill the SSE stream at GET /api/v1/events every
		// time it elapsed. Idle connections are bounded by IdleTimeout instead.
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 1 << 20,
	}
}

func serve(s *http.Server, ln net.Listener, logf logFunc) {
	if err := s.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		logf(protocol.LogError, "tailnet listener stopped: %v", err)
	}
}

// waitForRunning polls the daemon until the node is Running, publishing login-required with
// the interactive URL whenever the control server asks for one.
//
// There is deliberately no overall deadline: a user who must open a browser and sign in may
// take minutes, and the honest thing to show meanwhile is "login required", not a timeout.
func (e *Edge) waitForRunning(ctx context.Context, inst *instance, cfg protocol.NetworkConfig) (string, error) {
	ticker := time.NewTicker(statusPollInterval)
	defer ticker.Stop()

	loginStarted := false
	var needsLoginSince time.Time
	var consecutiveErrors int

	for {
		st, err := inst.lc.Status(ctx)
		if err != nil {
			consecutiveErrors++
			// The daemon is briefly unavailable while it starts; only a persistent failure
			// is worth reporting.
			if consecutiveErrors > 20 {
				return "", &edgeError{
					code: protocol.ErrCodeEdgeNotReady,
					msg:  "the local Tailscale daemon is not answering",
					err:  err,
				}
			}
		} else {
			consecutiveErrors = 0
			switch st.BackendState {
			case ipn.Running.String():
				if host := dnsNameOf(st, cfg); host != "" {
					return host, nil
				}
				// Running but MagicDNS has not assigned a name yet. Keep waiting rather
				// than publishing an address that will change.

			case ipn.NeedsLogin.String(), ipn.NeedsMachineAuth.String():
				// time.Now for the same reason as in Login: this loop is paced by a real
				// ticker, so its own clock has to be the real one too.
				if needsLoginSince.IsZero() {
					needsLoginSince = time.Now()
				}
				switch {
				case st.AuthURL != "":
					// publish, not SetLoginRequired: the same URL arrives here twice a second
					// until the user signs in, and it may also have arrived through tsnet's
					// log first. Only a genuine change reaches the tray.
					inst.login.publish(st.AuthURL)

				case !loginStarted && time.Since(needsLoginSince) >= loginNudgeDelay:
					// tsnet has had its chance and produced nothing; ask ourselves. See
					// loginNudgeDelay for why this waits instead of firing immediately.
					loginStarted = true
					e.opts.Logf(protocol.LogInfo,
						"no login URL after %s; asking the control server for one", loginNudgeDelay)
					if err := inst.lc.StartLoginInteractive(ctx); err != nil {
						e.opts.Logf(protocol.LogWarn, "could not start an interactive login: %v", err)
					}
				}

			case ipn.Stopped.String():
				return "", &edgeError{
					code: protocol.ErrCodeEdgeNotReady,
					msg:  "the tailnet node is stopped",
				}
			}
		}

		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-ticker.C:
		}
	}
}

// watch keeps the peer count and the certificate expiry current for the tray. It is
// informational: nothing in the serving path depends on it.
func (e *Edge) watch(ctx context.Context, inst *instance) {
	ticker := time.NewTicker(peerPollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}

		if st, err := inst.lc.Status(ctx); err == nil {
			e.opts.Status.SetPeers(onlinePeers(st))
		}
		if _, certs := inst.parts(); certs != nil {
			e.opts.Status.SetCertExpiry(certs.ExpiresAt())
		}
	}
}

// Login asks the control server for an interactive login URL and publishes it.
//
// netedge never opens a browser: it runs headless as a child process and has no business
// deciding what the user's screen does. Electron opens the URL.
func (e *Edge) Login(ctx context.Context) (string, error) {
	inst := e.current()
	if inst == nil {
		return "", &edgeError{code: protocol.ErrCodeEdgeNotReady, msg: "the tailnet node is not running"}
	}

	// What the store held before we asked. Anything that appears there after this point came
	// from the log scanner in response to this request; anything that was already there may be
	// the link from a session the user has since signed out of, and handing that back would
	// send them to a page that no longer works.
	before := loginURLOf(e.opts.Status.Get())

	if err := inst.lc.StartLoginInteractive(ctx); err != nil {
		return "", &edgeError{code: protocol.ErrCodeEdgeNotReady, msg: "could not start an interactive login", err: err}
	}

	// time.Now, not Options.Now: this loop is paced by a real ticker, and a deadline from an
	// injectable clock that a test had frozen would never be reached.
	deadline := time.Now().Add(loginURLWait)
	ticker := time.NewTicker(statusPollInterval)
	defer ticker.Stop()
	for time.Now().Before(deadline) {
		if st, err := inst.lc.Status(ctx); err == nil && st.AuthURL != "" {
			inst.login.publish(st.AuthURL)
			return st.AuthURL, nil
		}
		// The log scanner is the other source, and it can see the URL before Status reports
		// it. The caller wants a link to open, not a particular way of having found one.
		if now := loginURLOf(e.opts.Status.Get()); now != "" && now != before {
			return now, nil
		}
		select {
		case <-ctx.Done():
			return "", ctx.Err()
		case <-ticker.C:
		}
	}

	return "", &edgeError{
		code: protocol.ErrCodeEdgeLoginRequired,
		msg:  "the control server did not produce a login URL",
	}
}

// Logout unauthenticates the node and parks the state machine at login-required.
//
// It does not fetch a fresh URL: the user just asked to sign out, and immediately producing
// a new sign-in link would be the opposite of what they asked for. POST /edge/login gets one
// when they want it.
func (e *Edge) Logout(ctx context.Context) error {
	inst := e.current()
	if inst == nil {
		return &edgeError{code: protocol.ErrCodeEdgeNotReady, msg: "the tailnet node is not running"}
	}
	if err := inst.lc.Logout(ctx); err != nil {
		return &edgeError{code: protocol.ErrCodeInternal, msg: "logout failed", err: err}
	}
	if err := e.opts.Status.SetLoginRequired(""); err != nil {
		e.opts.Logf(protocol.LogWarn, "%v", err)
	}
	return nil
}

// Test runs the dry run behind POST /edge/test.
func (e *Edge) Test(ctx context.Context, cfg protocol.NetworkConfig) protocol.EdgeTestResult {
	return RunTest(ctx, cfg, TestDeps{
		DefaultControlURL: e.opts.TestDefaultControlURL,
	})
}

func (e *Edge) current() *instance {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.inst
}

// tsnetDir returns the state directory for a configuration.
//
// Each control plane gets its own subdirectory. A tsnet state file holds a node key that is
// only meaningful to the control server that issued it, so reusing one directory across a
// switch to Headscale and back would destroy the Tailscale identity and force a re-login
// every time the user changed their mind — which is precisely what spec 2.4 promises will
// not happen.
func (e *Edge) tsnetDir(cfg protocol.NetworkConfig) (string, error) {
	key := "default"
	if cfg.Mode == protocol.ModeCustom {
		key = "custom-" + sanitizeDirKey(cfg.ControlURL)
	}
	dir := filepath.Join(e.opts.StateDir, "tsnet", key)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create tsnet state directory %s: %w", dir, err)
	}
	return dir, nil
}

// sanitizeDirKey turns a control URL into something a filesystem accepts on Windows.
func sanitizeDirKey(controlURL string) string {
	s := strings.ToLower(controlURL)
	s = strings.TrimPrefix(s, "https://")
	s = strings.TrimPrefix(s, "http://")
	var b strings.Builder
	for _, r := range s {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9', r == '-', r == '.':
			b.WriteRune(r)
		default:
			b.WriteByte('_')
		}
	}
	out := strings.Trim(b.String(), "._")
	if out == "" {
		out = "unnamed"
	}
	// Windows path components are capped well below this; a long Headscale URL would
	// otherwise produce a directory the OS refuses to create.
	if len(out) > 64 {
		out = out[:64]
	}
	return out
}

// dnsNameOf picks the name clients will use to reach this node.
func dnsNameOf(st *ipnstate.Status, cfg protocol.NetworkConfig) string {
	if st != nil && st.Self != nil {
		if name := strings.TrimSuffix(st.Self.DNSName, "."); name != "" {
			return name
		}
	}
	// A Headscale deployment with MagicDNS switched off reports no name. The certificate
	// domain is the name the user's own DNS points at this node, so it is the right answer
	// there — and both non-control-plane strategies require it.
	return cfg.CertDomain
}

// certDomainFor is the name a certificate is requested for.
//
// In default mode that is the MagicDNS name the control plane will actually sign. In the
// other strategies it is the domain the user configured, because the control plane is not
// signing anything.
func certDomainFor(cfg protocol.NetworkConfig, host string) string {
	if cfg.CertStrategy == protocol.CertControlPlane {
		return host
	}
	if cfg.CertDomain != "" {
		return cfg.CertDomain
	}
	return host
}

// loginURLOf reads the published login URL out of a snapshot, treating "no URL" and "not
// waiting for a login" as the same empty answer.
func loginURLOf(st protocol.EdgeStatus) string {
	if st.State != protocol.StateLoginRequired || st.LoginURL == nil {
		return ""
	}
	return *st.LoginURL
}

// onlinePeers counts peers that are up, which is what the tray means by "devices connected".
func onlinePeers(st *ipnstate.Status) int {
	if st == nil {
		return 0
	}
	n := 0
	for _, p := range st.Peer {
		if p != nil && p.Online {
			n++
		}
	}
	return n
}

// stop tears one generation down. It is safe to call once; replace and Stop both drop their
// reference immediately afterwards.
func (i *instance) stop() {
	if i == nil {
		return
	}
	i.cancel()

	// Wait for the bring-up goroutine to notice the cancellation and return before taking
	// its listener and certificate provider away from under it. The wait is bounded because
	// a DNS-01 issuance can still be in flight, and a restart must not be hostage to
	// somebody else's DNS propagation.
	select {
	case <-i.done:
	case <-time.After(shutdownTimeout):
	}

	httpSrv, certs := i.parts()
	if httpSrv != nil {
		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		// Shutdown closes the listener too, so the tsnet server is not left with a socket
		// bound to a port the next generation wants.
		_ = httpSrv.Shutdown(ctx)
		cancel()
	}
	if certs != nil {
		_ = certs.Close()
	}
	if i.srv != nil {
		// Closing last: two tsnet servers must never hold the same state directory, and a
		// same-mode restart points the next generation at exactly this one.
		_ = i.srv.Close()
	}
}
