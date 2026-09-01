// Package control serves netedge's loopback-only HTTP API.
//
// Everything that can change the network configuration lives here and nowhere else, and it
// is reachable only from 127.0.0.1 behind a shared secret. Design spec 4.2 is explicit about
// why: a stolen device token must not be able to escalate, and the way to guarantee that is
// for the privilege-granting endpoints not to exist on the tailnet at all.
package control

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

const (
	// sseHeartbeat keeps the status stream alive through anything that reaps idle
	// connections, and gives the client something to notice if the process dies.
	sseHeartbeat = 15 * time.Second

	// maxBodyBytes caps a config or test body. These are small JSON objects; anything larger
	// is a mistake or an attempt to exhaust memory.
	maxBodyBytes = 1 << 20
)

// Controller is the half of Edge this package drives. It is an interface so the API can be
// tested without a tailnet — none of the handlers here need a real WireGuard node to be
// exercised.
type Controller interface {
	// Config returns the configuration in force, already stripped of secrets.
	Config() protocol.NetworkConfig
	Apply(cfg protocol.NetworkConfig) error
	Restart() error
	Login(ctx context.Context) (string, error)
	Logout(ctx context.Context) error
	Test(ctx context.Context, cfg protocol.NetworkConfig) protocol.EdgeTestResult
}

// StatusSource is the read side of the status store.
type StatusSource interface {
	Get() protocol.EdgeStatus
	Subscribe() (<-chan protocol.EdgeStatus, func())
}

// Options configures a Server.
type Options struct {
	// Port is the loopback port. Zero lets the OS choose, which is the normal case: the real
	// port is reported to Electron in the `ready` event, so nothing has to guess or contend
	// for a fixed number.
	Port int

	// Secret is required on every request as x-lc-edge-secret.
	Secret string

	Controller Controller
	Status     StatusSource
	Logf       func(level protocol.LogLevel, format string, args ...any)
}

// Server is the loopback control API.
type Server struct {
	opts Options
	ln   net.Listener
	http *http.Server
}

// New validates the options and builds the server. It does not bind; call Listen.
func New(opts Options) (*Server, error) {
	if opts.Secret == "" {
		return nil, errors.New("control: a shared secret is required")
	}
	if opts.Controller == nil {
		return nil, errors.New("control: a Controller is required")
	}
	if opts.Status == nil {
		return nil, errors.New("control: a StatusSource is required")
	}
	if opts.Logf == nil {
		opts.Logf = func(protocol.LogLevel, string, ...any) {}
	}
	s := &Server{opts: opts}
	s.http = &http.Server{
		Handler:           s.handler(),
		ReadHeaderTimeout: 10 * time.Second,
		// No WriteTimeout: /edge/status/stream is a long-lived SSE response and a write
		// deadline would sever it on a fixed schedule.
		IdleTimeout:    120 * time.Second,
		MaxHeaderBytes: 1 << 16,
	}
	return s, nil
}

// Listen binds the loopback socket and returns the port that was actually assigned.
//
// The address is 127.0.0.1, never 0.0.0.0. Binding a wildcard would put the endpoint that
// can repoint the whole network configuration on every interface of the machine, including
// the tailnet itself.
func (s *Server) Listen() (int, error) {
	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", s.opts.Port))
	if err != nil {
		return 0, fmt.Errorf("bind control API on 127.0.0.1:%d: %w", s.opts.Port, err)
	}
	s.ln = ln

	addr, ok := ln.Addr().(*net.TCPAddr)
	if !ok {
		_ = ln.Close()
		return 0, fmt.Errorf("control API bound to an unexpected address %v", ln.Addr())
	}
	return addr.Port, nil
}

// Serve runs until Shutdown. Listen must have been called.
func (s *Server) Serve() error {
	if s.ln == nil {
		return errors.New("control: Listen must be called before Serve")
	}
	if err := s.http.Serve(s.ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("control API: %w", err)
	}
	return nil
}

// Shutdown stops accepting and waits for in-flight requests.
func (s *Server) Shutdown(ctx context.Context) error {
	if s.http == nil {
		return nil
	}
	return s.http.Shutdown(ctx)
}

func (s *Server) handler() http.Handler {
	mux := http.NewServeMux()

	// Method-qualified patterns, so a GET to a PUT-only route is a 405 from the router
	// rather than a hand-written check in every handler.
	mux.HandleFunc("GET "+protocol.RouteStatus, s.handleStatus)
	mux.HandleFunc("GET "+protocol.RouteStatusStream, s.handleStatusStream)
	mux.HandleFunc("GET "+protocol.RouteConfig, s.handleGetConfig)
	mux.HandleFunc("PUT "+protocol.RouteConfig, s.handlePutConfig)
	mux.HandleFunc("POST "+protocol.RouteTest, s.handleTest)
	mux.HandleFunc("POST "+protocol.RouteLogin, s.handleLogin)
	mux.HandleFunc("POST "+protocol.RouteLogout, s.handleLogout)
	mux.HandleFunc("POST "+protocol.RouteRestart, s.handleRestart)

	return s.withGuards(mux)
}

// withGuards applies the two checks every request must pass.
func (s *Server) withGuards(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// The Host check defends against DNS rebinding: a page the user visits can resolve
		// an attacker-controlled name to 127.0.0.1 and then talk to whatever is listening
		// there. The shared secret already stops that attack — the page cannot know it — so
		// this is defence in depth, and it costs one string comparison.
		if !isLoopbackHost(r.Host) {
			writeError(w, http.StatusForbidden, protocol.ErrCodeBadRequest,
				"the control API answers only on 127.0.0.1")
			return
		}

		// Constant-time comparison: the secret is a fixed value checked on every request,
		// and a byte-at-a-time comparison against a local caller is exactly the situation
		// where timing is measurable.
		got := r.Header.Get(protocol.HeaderEdgeSecret)
		if subtle.ConstantTimeCompare([]byte(got), []byte(s.opts.Secret)) != 1 {
			writeError(w, http.StatusUnauthorized, protocol.ErrCodeUnauthenticated,
				"missing or incorrect "+protocol.HeaderEdgeSecret)
			return
		}

		next.ServeHTTP(w, r)
	})
}

// isLoopbackHost reports whether the Host header names this machine's loopback.
func isLoopbackHost(host string) bool {
	if host == "" {
		// HTTP/1.0 and some local clients send no Host. There is nothing to rebind through
		// in that case, and the secret still has to be right.
		return true
	}
	name := host
	if h, _, err := net.SplitHostPort(host); err == nil {
		name = h
	}
	switch strings.ToLower(strings.Trim(name, "[]")) {
	case "127.0.0.1", "::1", "localhost":
		return true
	}
	return false
}

// ─── handlers ────────────────────────────────────────────────────────────────

func (s *Server) handleStatus(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.opts.Status.Get())
}

// handleStatusStream is the SSE endpoint the tray and the settings page follow.
//
// SSE rather than a WebSocket for the same reason the device API uses it (spec 4.1): the
// traffic is one-directional, the browser reconnects by itself, and there is no handshake to
// get wrong.
func (s *Server) handleStatusStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		writeError(w, http.StatusInternalServerError, protocol.ErrCodeInternal,
			"this server cannot stream")
		return
	}

	h := w.Header()
	h.Set("Content-Type", "text/event-stream")
	h.Set("Cache-Control", "no-cache")
	h.Set("Connection", "keep-alive")
	// Belt and braces if anything ever fronts this endpoint.
	h.Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()

	ch, cancel := s.opts.Status.Subscribe()
	defer cancel()

	// Send the current status immediately. A subscriber that arrives between two
	// transitions would otherwise render nothing until the next one, which for a connected
	// node that is not changing could be for ever.
	if !writeSSE(w, flusher, s.opts.Status.Get()) {
		return
	}

	heartbeat := time.NewTicker(sseHeartbeat)
	defer heartbeat.Stop()

	ctx := r.Context()
	for {
		select {
		case <-ctx.Done():
			return

		case st, open := <-ch:
			if !open {
				return
			}
			if !writeSSE(w, flusher, st) {
				return
			}

		case <-heartbeat.C:
			// A comment line: valid SSE, ignored by every client, enough to keep the
			// connection from being reaped as idle.
			if _, err := fmt.Fprint(w, ": keepalive\n\n"); err != nil {
				return
			}
			flusher.Flush()
		}
	}
}

func writeSSE(w http.ResponseWriter, flusher http.Flusher, st protocol.EdgeStatus) bool {
	raw, err := json.Marshal(st)
	if err != nil {
		return false
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", raw); err != nil {
		return false
	}
	flusher.Flush()
	return true
}

// handleGetConfig answers with the configuration minus its secrets.
//
// Not redacted — absent. A settings page that read back "[redacted]", edited the hostname
// and PUT the whole object would otherwise store the placeholder as the auth key. Electron
// holds the encrypted copy and re-supplies it on save.
func (s *Server) handleGetConfig(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, s.opts.Controller.Config().WithoutSecrets())
}

// handlePutConfig applies a new configuration. The tsnet node is replaced inside this
// process; nothing here exits and the database is untouched (spec 2.4).
func (s *Server) handlePutConfig(w http.ResponseWriter, r *http.Request) {
	cfg, ok := decodeConfig(w, r)
	if !ok {
		return
	}

	if err := s.opts.Controller.Apply(cfg); err != nil {
		writeConfigError(w, err)
		return
	}

	s.opts.Logf(protocol.LogInfo, "network configuration applied: %s", cfg.String())
	writeJSON(w, http.StatusOK, s.opts.Controller.Config().WithoutSecrets())
}

// handleTest is the dry run that gates saving.
func (s *Server) handleTest(w http.ResponseWriter, r *http.Request) {
	cfg, ok := decodeConfig(w, r)
	if !ok {
		return
	}
	// A test result is always 200: the answer to "can this configuration work" is the body,
	// not the status code. An HTTP error here would be indistinguishable from the control
	// API itself failing.
	writeJSON(w, http.StatusOK, s.opts.Controller.Test(r.Context(), cfg))
}

// loginResponse is the body of POST /edge/login. Electron opens the URL; netedge never
// launches a browser.
type loginResponse struct {
	LoginURL string `json:"loginUrl"`
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	loginURL, err := s.opts.Controller.Login(r.Context())
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, protocol.ErrCodeEdgeLoginRequired, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, loginResponse{LoginURL: loginURL})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if err := s.opts.Controller.Logout(r.Context()); err != nil {
		writeError(w, http.StatusServiceUnavailable, protocol.ErrCodeEdgeNotReady, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRestart(w http.ResponseWriter, _ *http.Request) {
	if err := s.opts.Controller.Restart(); err != nil {
		writeError(w, http.StatusServiceUnavailable, protocol.ErrCodeEdgeNotReady, err.Error())
		return
	}
	// 202: the node is being rebuilt in the background and the caller should follow the
	// status stream rather than wait on this request.
	w.WriteHeader(http.StatusAccepted)
}

// ─── plumbing ────────────────────────────────────────────────────────────────

// decodeConfig reads a NetworkConfig body, writing the error response itself when it cannot.
func decodeConfig(w http.ResponseWriter, r *http.Request) (protocol.NetworkConfig, bool) {
	defer func() { _ = r.Body.Close() }()

	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxBodyBytes))
	// Unknown fields are refused so a field renamed on the TypeScript side without being
	// renamed here fails immediately, rather than being silently dropped and applied as a
	// zero value.
	dec.DisallowUnknownFields()

	var cfg protocol.NetworkConfig
	if err := dec.Decode(&cfg); err != nil {
		writeError(w, http.StatusBadRequest, protocol.ErrCodeBadRequest,
			"could not parse the network configuration: "+err.Error())
		return protocol.NetworkConfig{}, false
	}
	cfg.ApplyDefaults()
	return cfg, true
}

// writeConfigError maps a validation failure onto the machine code the settings page
// branches on, so "Headscale cannot do this" does not arrive as a generic 400.
func writeConfigError(w http.ResponseWriter, err error) {
	var verrs protocol.ValidationErrors
	if errors.As(err, &verrs) {
		// Both bad_request and edge_mode_unsupported are 400 in the contract's errorStatus
		// table; the code, not the status, is what the settings page reads.
		writeError(w, http.StatusBadRequest, verrs.Code(), verrs.Error())
		return
	}
	writeError(w, http.StatusInternalServerError, protocol.ErrCodeInternal, err.Error())
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, protocol.NewAPIError(code, message))
}
