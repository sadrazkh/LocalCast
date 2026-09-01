// Command netedge is LocalCast's network edge: a userspace WireGuard node that terminates
// TLS on the tailnet and reverse-proxies to the Node server on loopback.
//
// It is an ordinary child process of the Electron app. No UAC prompt, no Windows service, no
// TUN driver — that constraint is what makes "install and click once" possible, and it is
// why the tailnet is embedded (tsnet) rather than delegated to an installed Tailscale
// client.
//
// Two channels talk to the parent:
//   - stdout carries newline-delimited JSON matching edgeStdoutEventSchema in
//     packages/contract/src/netedge.ts. Nothing else is ever written there.
//   - the loopback control API on --control-port carries requests in the other direction.
//     Its real port is announced in the first `ready` event, so nothing has to agree on a
//     fixed number in advance.
package main

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"github.com/sadrazkh/localcast/netedge/internal/config"
	"github.com/sadrazkh/localcast/netedge/internal/control"
	"github.com/sadrazkh/localcast/netedge/internal/edge"
	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

const (
	// secretEnv is the preferred way to pass the shared secret. A command line is readable
	// by every process on the machine through the process list, and this secret is the Node
	// server's proof that a request came through the edge.
	secretEnv = "LOCALCAST_EDGE_SECRET"

	// minSecretBytes is the smallest shared secret worth having. 16 bytes of hex is 32
	// characters.
	minSecretBytes = 16

	// shutdownGrace bounds the whole exit path, so a wedged tailnet cannot leave a process
	// behind for the installer to trip over on the next upgrade.
	shutdownGrace = 20 * time.Second
)

func main() {
	if err := run(); err != nil {
		// stdout is reserved for the NDJSON protocol, so a fatal error goes to stderr where
		// Electron logs it as plain text.
		fmt.Fprintf(os.Stderr, "netedge: %v\n", err)
		os.Exit(1)
	}
}

func run() error {
	var (
		configPath = flag.String("config", "",
			"path to the network configuration file (default: <state-dir>/"+config.FileName+")")
		controlPort = flag.Int("control-port", 0,
			"loopback port for the control API; 0 lets the OS choose and the port is reported in the ready event")
		upstream = flag.String("upstream", "",
			"host:port of the loopback LocalCast server to reverse-proxy to (required)")
		sharedSecret = flag.String("shared-secret", "",
			"hex-encoded secret injected as "+protocol.HeaderEdgeSecret+"; prefer the "+secretEnv+" environment variable")
		stateDir = flag.String("state-dir", "",
			"directory for the tailnet node state and the certificate cache (required)")
		logLevel = flag.String("log-level", "info",
			"lowest level emitted as a log event on stdout: debug, info, warn or error")
	)
	flag.Parse()

	if *stateDir == "" {
		return errors.New("--state-dir is required")
	}
	if *upstream == "" {
		return errors.New("--upstream is required")
	}
	secret, err := resolveSecret(*sharedSecret)
	if err != nil {
		return err
	}
	level, err := parseLevel(*logLevel)
	if err != nil {
		return err
	}

	path := *configPath
	if path == "" {
		path = config.DefaultPath(*stateDir)
	}

	out := newEmitter(os.Stdout, level)

	file, err := config.Load(path)
	if err != nil {
		return err
	}
	out.logf(protocol.LogInfo, "loaded %s", file.String())

	status := edge.NewStatusStore(time.Now)

	edgeOpts := edge.Options{
		Upstream:     *upstream,
		SharedSecret: secret,
		StateDir:     *stateDir,
		Status:       status,
		Logf:         out.logf,
		Now:          time.Now,
	}

	ed, err := edge.New(file.Network, edgeOpts)
	if err != nil {
		// A stored configuration that no longer validates must not take the control API down
		// with it. The settings page is where this gets fixed and it is only reachable while
		// this process is alive, so fall back to the zero-input default and say so loudly.
		// The bad file is left on disk: overwriting it silently would destroy the evidence.
		out.logf(protocol.LogError,
			"the stored network configuration is not usable and has been ignored: %v", err)
		ed, err = edge.New(config.Default().Network, edgeOpts)
		if err != nil {
			return fmt.Errorf("the built-in default configuration is not usable: %w", err)
		}
	}

	api, err := control.New(control.Options{
		Port:       *controlPort,
		Secret:     secret,
		Controller: &persistingController{edge: ed, path: path, logf: out.logf},
		Status:     status,
		Logf:       out.logf,
	})
	if err != nil {
		return err
	}

	port, err := api.Listen()
	if err != nil {
		return err
	}

	// Announce the port before anything slow happens. Until Electron has it there is no way
	// to reach netedge at all, including to fix a configuration that will not start.
	out.emit(protocol.ReadyEvent(port))
	out.logf(protocol.LogInfo, "control API listening on 127.0.0.1:%d", port)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	go forwardStatus(ctx, status, out)

	served := make(chan error, 1)
	go func() { served <- api.Serve() }()

	if err := ed.Start(ctx); err != nil {
		// Deliberately not fatal. The control API is up, the status carries the reason, and
		// the settings page is the place this gets fixed — exiting here would take that page
		// away along with the problem.
		out.logf(protocol.LogError, "the stored network configuration did not start: %v", err)
	}

	select {
	case <-ctx.Done():
		out.logf(protocol.LogInfo, "shutting down")
	case err := <-served:
		if err != nil {
			return err
		}
	}

	shutCtx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
	defer cancel()
	if err := api.Shutdown(shutCtx); err != nil {
		out.logf(protocol.LogWarn, "control API did not shut down cleanly: %v", err)
	}
	ed.Stop()

	// One last snapshot so the tray shows "stopped" rather than freezing on whatever was
	// true a moment before the signal.
	out.emit(protocol.StatusEvent(status.Get()))
	return nil
}

// forwardStatus mirrors every status change onto stdout.
func forwardStatus(ctx context.Context, status *edge.StatusStore, out *emitter) {
	ch, cancel := status.Subscribe()
	defer cancel()

	// The current status first: Electron subscribes after netedge has already started
	// working, and would otherwise render nothing until the next transition.
	out.emit(protocol.StatusEvent(status.Get()))

	for {
		select {
		case <-ctx.Done():
			return
		case st, open := <-ch:
			if !open {
				return
			}
			out.emit(protocol.StatusEvent(st))
		}
	}
}

// persistingController couples the edge to the configuration file.
//
// Applying a configuration and making it survive a restart are one operation as far as the
// settings page is concerned, and splitting them across two callers is how the two end up
// disagreeing.
type persistingController struct {
	edge *edge.Edge
	path string
	logf func(protocol.LogLevel, string, ...any)
}

func (c *persistingController) Config() protocol.NetworkConfig { return c.edge.Config() }

func (c *persistingController) Apply(cfg protocol.NetworkConfig) error {
	if err := c.edge.Apply(cfg); err != nil {
		return err
	}

	// Save only after the edge accepted it, so a refused configuration never reaches disk.
	// config.Save strips the auth key and the DNS token; they stay in this process's memory
	// and in Electron's DPAPI store, and nowhere else.
	if err := config.Save(c.path, config.File{Network: cfg}); err != nil {
		// The node is already running the new configuration. Failing the request now would
		// tell the user the opposite of what happened, so this is loud but not fatal.
		c.logf(protocol.LogError, "the new configuration is live but could not be written to %s: %v", c.path, err)
	}
	return nil
}

func (c *persistingController) Restart() error { return c.edge.Restart() }

func (c *persistingController) Login(ctx context.Context) (string, error) { return c.edge.Login(ctx) }

func (c *persistingController) Logout(ctx context.Context) error { return c.edge.Logout(ctx) }

func (c *persistingController) Test(ctx context.Context, cfg protocol.NetworkConfig) protocol.EdgeTestResult {
	return c.edge.Test(ctx, cfg)
}

// ─── stdout ──────────────────────────────────────────────────────────────────

// emitter is the only thing in this process that writes to stdout. Everything goes through
// its lock, because two goroutines interleaving halfway through a JSON object would produce
// a line Electron cannot parse and would have no way to resynchronise from.
type emitter struct {
	mu    sync.Mutex
	enc   *json.Encoder
	level int
}

func newEmitter(w io.Writer, level int) *emitter {
	return &emitter{enc: json.NewEncoder(w), level: level}
}

func (e *emitter) emit(ev protocol.EdgeStdoutEvent) {
	e.mu.Lock()
	defer e.mu.Unlock()
	// json.Encoder appends a newline after every value, which is exactly the framing the
	// contract asks for.
	if err := e.enc.Encode(ev); err != nil {
		fmt.Fprintf(os.Stderr, "netedge: cannot write to stdout: %v\n", err)
	}
}

// logf emits a log event, dropping anything below the configured level.
//
// The filter matters more than it looks: tsnet's own debug logging is voluminous, and if
// Electron ever stops draining the pipe a flooded stdout blocks this process in a write
// rather than doing its job.
func (e *emitter) logf(level protocol.LogLevel, format string, args ...any) {
	if levelRank(level) < e.level {
		return
	}
	e.emit(protocol.LogEvent(level, fmt.Sprintf(format, args...)))
}

func levelRank(level protocol.LogLevel) int {
	switch level {
	case protocol.LogDebug:
		return 0
	case protocol.LogInfo:
		return 1
	case protocol.LogWarn:
		return 2
	case protocol.LogError:
		return 3
	default:
		return 1
	}
}

func parseLevel(s string) (int, error) {
	switch protocol.LogLevel(s) {
	case protocol.LogDebug, protocol.LogInfo, protocol.LogWarn, protocol.LogError:
		return levelRank(protocol.LogLevel(s)), nil
	default:
		return 0, fmt.Errorf("--log-level must be debug, info, warn or error, not %q", s)
	}
}

// ─── flags ───────────────────────────────────────────────────────────────────

// resolveSecret prefers the environment over the flag and insists the value is real.
func resolveSecret(flagValue string) (string, error) {
	secret := os.Getenv(secretEnv)
	if secret == "" {
		secret = flagValue
	}
	if secret == "" {
		return "", fmt.Errorf("a shared secret is required: set %s or pass --shared-secret", secretEnv)
	}

	// The contract describes it as hex. Checking that here turns "the wrong argument was
	// passed" into a message at startup rather than a Node server that rejects every
	// request with 401 and no explanation.
	raw, err := hex.DecodeString(secret)
	if err != nil {
		return "", fmt.Errorf("the shared secret must be hex-encoded: %w", err)
	}
	if len(raw) < minSecretBytes {
		return "", fmt.Errorf("the shared secret must be at least %d bytes (%d hex characters), got %d",
			minSecretBytes, minSecretBytes*2, len(raw))
	}
	return secret, nil
}
