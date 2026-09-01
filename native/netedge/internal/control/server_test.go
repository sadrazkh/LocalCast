package control

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

const secret = "6f1e0a2b3c4d5e6f7a8b9c0d1e2f3a4b"

// fakeController records what the API asked of the edge and answers with whatever the test
// set up. The real Edge needs a tailnet; none of these handlers do.
type fakeController struct {
	mu sync.Mutex

	cfg      protocol.NetworkConfig
	applied  []protocol.NetworkConfig
	restarts int

	applyErr  error
	loginURL  string
	loginErr  error
	logoutErr error
	result    protocol.EdgeTestResult
	tested    []protocol.NetworkConfig
}

func (f *fakeController) Config() protocol.NetworkConfig {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cfg
}

func (f *fakeController) Apply(cfg protocol.NetworkConfig) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.applyErr != nil {
		return f.applyErr
	}
	if err := cfg.Validate(); err != nil {
		return err
	}
	f.applied = append(f.applied, cfg)
	f.cfg = cfg
	return nil
}

func (f *fakeController) Restart() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.restarts++
	return nil
}

func (f *fakeController) Login(context.Context) (string, error) {
	return f.loginURL, f.loginErr
}

func (f *fakeController) Logout(context.Context) error { return f.logoutErr }

func (f *fakeController) Test(_ context.Context, cfg protocol.NetworkConfig) protocol.EdgeTestResult {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.tested = append(f.tested, cfg)
	return f.result
}

// fakeStatus is a minimal StatusSource.
type fakeStatus struct {
	mu   sync.Mutex
	cur  protocol.EdgeStatus
	subs []chan protocol.EdgeStatus
}

func (f *fakeStatus) Get() protocol.EdgeStatus {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.cur
}

func (f *fakeStatus) Subscribe() (<-chan protocol.EdgeStatus, func()) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ch := make(chan protocol.EdgeStatus, 8)
	f.subs = append(f.subs, ch)
	return ch, func() {}
}

func (f *fakeStatus) publish(st protocol.EdgeStatus) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.cur = st
	for _, ch := range f.subs {
		select {
		case ch <- st:
		default:
		}
	}
}

func newTestServer(t *testing.T) (*httptest.Server, *fakeController, *fakeStatus) {
	t.Helper()

	ctrl := &fakeController{
		cfg: protocol.NetworkConfig{
			Mode:         protocol.ModeDefault,
			Expose:       protocol.ExposeTailnet,
			CertStrategy: protocol.CertControlPlane,
			Hostname:     protocol.DefaultHostname,
		},
		result: protocol.NewEdgeTestResult(),
	}
	status := &fakeStatus{cur: protocol.EdgeStatus{State: protocol.StateStopped}}

	s, err := New(Options{Secret: secret, Controller: ctrl, Status: status})
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ts := httptest.NewServer(s.handler())
	t.Cleanup(ts.Close)
	return ts, ctrl, status
}

func do(t *testing.T, ts *httptest.Server, method, path string, body any, withSecret bool) *http.Response {
	t.Helper()

	var r io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			t.Fatalf("marshal body: %v", err)
		}
		r = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, ts.URL+path, r)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	if withSecret {
		req.Header.Set(protocol.HeaderEdgeSecret, secret)
	}
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, path, err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	return resp
}

// TestSecretRequiredOnEveryRoute: the loopback API is the one place that can repoint the
// whole network configuration, so no route may be reachable without the secret.
func TestSecretRequiredOnEveryRoute(t *testing.T) {
	ts, _, _ := newTestServer(t)

	routes := []struct{ method, path string }{
		{http.MethodGet, protocol.RouteStatus},
		{http.MethodGet, protocol.RouteStatusStream},
		{http.MethodGet, protocol.RouteConfig},
		{http.MethodPut, protocol.RouteConfig},
		{http.MethodPost, protocol.RouteTest},
		{http.MethodPost, protocol.RouteLogin},
		{http.MethodPost, protocol.RouteLogout},
		{http.MethodPost, protocol.RouteRestart},
	}

	for _, rt := range routes {
		t.Run(rt.method+" "+rt.path, func(t *testing.T) {
			resp := do(t, ts, rt.method, rt.path, nil, false)
			if resp.StatusCode != http.StatusUnauthorized {
				t.Errorf("status = %d, want 401", resp.StatusCode)
			}
			var body protocol.APIError
			if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
				t.Fatalf("decode: %v", err)
			}
			if body.Error.Code != protocol.ErrCodeUnauthenticated {
				t.Errorf("code = %q", body.Error.Code)
			}
		})
	}
}

func TestWrongSecretIsRefused(t *testing.T) {
	ts, _, _ := newTestServer(t)

	req, err := http.NewRequest(http.MethodGet, ts.URL+protocol.RouteStatus, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	// Same length, one byte different: the constant-time comparison must still reject it.
	req.Header.Set(protocol.HeaderEdgeSecret, strings.Replace(secret, "6", "7", 1))

	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", resp.StatusCode)
	}
}

// TestRebindingHostIsRefused: a page the user visits can point a hostname at 127.0.0.1. The
// secret already stops it; this is the second lock.
func TestRebindingHostIsRefused(t *testing.T) {
	ts, _, _ := newTestServer(t)

	req, err := http.NewRequest(http.MethodGet, ts.URL+protocol.RouteStatus, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set(protocol.HeaderEdgeSecret, secret)
	req.Host = "evil.example.com"

	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status = %d, want 403", resp.StatusCode)
	}
}

func TestIsLoopbackHost(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1:45123":     true,
		"127.0.0.1":           true,
		"localhost:45123":     true,
		"LOCALHOST:1":         true,
		"[::1]:45123":         true,
		"":                    true,
		"evil.example.com":    false,
		"192.168.1.4:45123":   false,
		"localcast.ts.net:80": false,
	}
	for in, want := range cases {
		if got := isLoopbackHost(in); got != want {
			t.Errorf("isLoopbackHost(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestWrongMethodIs405(t *testing.T) {
	ts, _, _ := newTestServer(t)

	resp := do(t, ts, http.MethodDelete, protocol.RouteConfig, nil, true)
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", resp.StatusCode)
	}
}

func TestGetStatus(t *testing.T) {
	ts, _, status := newTestServer(t)
	status.publish(protocol.EdgeStatus{
		State:     protocol.StateConnected,
		Host:      protocol.Ptr("localcast.tail1234.ts.net"),
		Peers:     2,
		UpdatedAt: 1756684800000,
	})

	resp := do(t, ts, http.MethodGet, protocol.RouteStatus, nil, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}

	var got protocol.EdgeStatus
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.State != protocol.StateConnected {
		t.Errorf("state = %q", got.State)
	}
	if got.Host == nil || *got.Host != "localcast.tail1234.ts.net" {
		t.Errorf("host = %v", got.Host)
	}
}

// TestGetConfigOmitsSecrets: the response is what a settings page reads back and PUTs again,
// so a placeholder here would be stored as the real key on the next save.
func TestGetConfigOmitsSecrets(t *testing.T) {
	ts, ctrl, _ := newTestServer(t)
	ctrl.cfg = protocol.NetworkConfig{
		Mode:         protocol.ModeCustom,
		ControlURL:   "https://hs.example.com",
		AuthKey:      "tskey-auth-VERYSECRET",
		Expose:       protocol.ExposeTailnet,
		CertStrategy: protocol.CertDNS01,
		CertDomain:   "cast.example.com",
		DNSProvider:  protocol.DNSProviderCloudflare,
		DNSAPIToken:  "cf_live_VERYSECRET",
		Hostname:     protocol.DefaultHostname,
	}

	resp := do(t, ts, http.MethodGet, protocol.RouteConfig, nil, true)
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read: %v", err)
	}

	for _, forbidden := range []string{
		"tskey-auth-VERYSECRET",
		"cf_live_VERYSECRET",
		protocol.RedactedPlaceholder,
	} {
		if bytes.Contains(raw, []byte(forbidden)) {
			t.Errorf("%q appears in the response: %s", forbidden, raw)
		}
	}
	if !bytes.Contains(raw, []byte("hs.example.com")) {
		t.Errorf("non-secret fields were dropped: %s", raw)
	}
}

func TestPutConfigApplies(t *testing.T) {
	ts, ctrl, _ := newTestServer(t)

	next := protocol.NetworkConfig{
		Mode:         protocol.ModeCustom,
		ControlURL:   "https://hs.example.com",
		AuthKey:      "tskey-auth-VERYSECRET",
		Expose:       protocol.ExposeTailnet,
		CertStrategy: protocol.CertExternalProxy,
		CertDomain:   "cast.example.com",
		Hostname:     "study",
	}

	resp := do(t, ts, http.MethodPut, protocol.RouteConfig, next, true)
	if resp.StatusCode != http.StatusOK {
		raw, _ := io.ReadAll(resp.Body)
		t.Fatalf("status = %d: %s", resp.StatusCode, raw)
	}

	ctrl.mu.Lock()
	applied := append([]protocol.NetworkConfig(nil), ctrl.applied...)
	ctrl.mu.Unlock()

	if len(applied) != 1 {
		t.Fatalf("Apply was called %d times, want 1", len(applied))
	}
	// The secret must reach the edge — it is needed to register with Headscale — even though
	// it never reaches the response or the disk.
	if applied[0].AuthKey != "tskey-auth-VERYSECRET" {
		t.Errorf("the auth key did not reach the edge: %s", applied[0].String())
	}

	raw, _ := io.ReadAll(resp.Body)
	if bytes.Contains(raw, []byte("tskey-auth-VERYSECRET")) {
		t.Errorf("the response echoed the auth key: %s", raw)
	}
}

// TestPutConfigRejectsTheImpossibleCombination: the settings page branches on the code, so
// "Headscale cannot do this" must not arrive as a generic 400.
func TestPutConfigRejectsTheImpossibleCombination(t *testing.T) {
	ts, ctrl, _ := newTestServer(t)

	resp := do(t, ts, http.MethodPut, protocol.RouteConfig, protocol.NetworkConfig{
		Mode:         protocol.ModeCustom,
		ControlURL:   "https://hs.example.com",
		Expose:       protocol.ExposeTailnet,
		CertStrategy: protocol.CertControlPlane,
		Hostname:     protocol.DefaultHostname,
	}, true)

	if resp.StatusCode != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", resp.StatusCode)
	}
	var body protocol.APIError
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error.Code != protocol.ErrCodeEdgeModeUnsupported {
		t.Errorf("code = %q, want %q", body.Error.Code, protocol.ErrCodeEdgeModeUnsupported)
	}

	ctrl.mu.Lock()
	defer ctrl.mu.Unlock()
	if len(ctrl.applied) != 0 {
		t.Error("a refused configuration was applied anyway")
	}
}

func TestPutConfigRejectsGarbage(t *testing.T) {
	ts, _, _ := newTestServer(t)

	req, err := http.NewRequest(http.MethodPut, ts.URL+protocol.RouteConfig, strings.NewReader("{"))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set(protocol.HeaderEdgeSecret, secret)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestPutConfigRejectsUnknownFields(t *testing.T) {
	ts, _, _ := newTestServer(t)

	body := `{"mode":"default","expose":"tailnet","certStrategy":"control-plane",` +
		`"hostname":"localcast","certStrategyy":"typo"}`
	req, err := http.NewRequest(http.MethodPut, ts.URL+protocol.RouteConfig, strings.NewReader(body))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set(protocol.HeaderEdgeSecret, secret)
	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400; a renamed field must fail loudly, not be dropped", resp.StatusCode)
	}
}

// TestTestEndpointAlwaysReturns200: the verdict is the body. An HTTP error would be
// indistinguishable from the control API itself failing.
func TestTestEndpointAlwaysReturns200(t *testing.T) {
	ts, ctrl, _ := newTestServer(t)
	ctrl.result = protocol.EdgeTestResult{
		Ok:                false,
		ControlReachable:  true,
		CertificateViable: false,
		Messages: []protocol.TestMessage{
			{Level: protocol.MessageError, Text: "Headscale cannot issue a certificate"},
		},
	}

	resp := do(t, ts, http.MethodPost, protocol.RouteTest, protocol.NetworkConfig{
		Mode:         protocol.ModeCustom,
		ControlURL:   "https://hs.example.com",
		Expose:       protocol.ExposeTailnet,
		CertStrategy: protocol.CertControlPlane,
		Hostname:     protocol.DefaultHostname,
	}, true)

	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var got protocol.EdgeTestResult
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got.Ok || got.CertificateViable {
		t.Errorf("verdict was not carried through: %+v", got)
	}

	// A configuration that cannot be saved must still be testable — that is the whole point
	// of the endpoint.
	ctrl.mu.Lock()
	defer ctrl.mu.Unlock()
	if len(ctrl.tested) != 1 {
		t.Fatalf("Test was called %d times, want 1", len(ctrl.tested))
	}
}

func TestLoginReturnsTheURL(t *testing.T) {
	ts, ctrl, _ := newTestServer(t)
	ctrl.loginURL = "https://login.tailscale.com/a/abcdef"

	resp := do(t, ts, http.MethodPost, protocol.RouteLogin, nil, true)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var body loginResponse
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.LoginURL != ctrl.loginURL {
		t.Errorf("loginUrl = %q", body.LoginURL)
	}
}

func TestLoginFailureIsTyped(t *testing.T) {
	ts, ctrl, _ := newTestServer(t)
	ctrl.loginErr = errors.New("the control server did not produce a login URL")

	resp := do(t, ts, http.MethodPost, protocol.RouteLogin, nil, true)
	if resp.StatusCode != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", resp.StatusCode)
	}
	var body protocol.APIError
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if body.Error.Code != protocol.ErrCodeEdgeLoginRequired {
		t.Errorf("code = %q", body.Error.Code)
	}
}

func TestLogoutAndRestart(t *testing.T) {
	ts, ctrl, _ := newTestServer(t)

	if resp := do(t, ts, http.MethodPost, protocol.RouteLogout, nil, true); resp.StatusCode != http.StatusNoContent {
		t.Errorf("logout status = %d, want 204", resp.StatusCode)
	}
	if resp := do(t, ts, http.MethodPost, protocol.RouteRestart, nil, true); resp.StatusCode != http.StatusAccepted {
		t.Errorf("restart status = %d, want 202", resp.StatusCode)
	}

	ctrl.mu.Lock()
	defer ctrl.mu.Unlock()
	if ctrl.restarts != 1 {
		t.Errorf("Restart was called %d times, want 1", ctrl.restarts)
	}
}

// TestStatusStreamSendsCurrentThenUpdates: a subscriber that arrives between two transitions
// would otherwise render nothing until the next one, which for a stable connected node could
// be for ever.
func TestStatusStreamSendsCurrentThenUpdates(t *testing.T) {
	ts, _, status := newTestServer(t)
	status.publish(protocol.EdgeStatus{State: protocol.StateConnecting})

	req, err := http.NewRequest(http.MethodGet, ts.URL+protocol.RouteStatusStream, nil)
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	req.Header.Set(protocol.HeaderEdgeSecret, secret)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	req = req.WithContext(ctx)

	resp, err := ts.Client().Do(req)
	if err != nil {
		t.Fatalf("do: %v", err)
	}
	defer func() { _ = resp.Body.Close() }()

	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("Content-Type = %q", ct)
	}

	events := make(chan protocol.EdgeStatus, 4)
	go func() {
		scanner := bufio.NewScanner(resp.Body)
		for scanner.Scan() {
			line := scanner.Text()
			data, ok := strings.CutPrefix(line, "data: ")
			if !ok {
				continue
			}
			var st protocol.EdgeStatus
			if err := json.Unmarshal([]byte(data), &st); err == nil {
				select {
				case events <- st:
				default:
				}
			}
		}
	}()

	first := recvStatus(t, events)
	if first.State != protocol.StateConnecting {
		t.Errorf("first event state = %q, want the current status", first.State)
	}

	status.publish(protocol.EdgeStatus{State: protocol.StateConnected})
	second := recvStatus(t, events)
	if second.State != protocol.StateConnected {
		t.Errorf("second event state = %q", second.State)
	}
}

func recvStatus(t *testing.T, ch <-chan protocol.EdgeStatus) protocol.EdgeStatus {
	t.Helper()
	select {
	case st := <-ch:
		return st
	case <-time.After(5 * time.Second):
		t.Fatal("no SSE event arrived")
		return protocol.EdgeStatus{}
	}
}

func TestNewValidatesOptions(t *testing.T) {
	valid := Options{
		Secret:     secret,
		Controller: &fakeController{},
		Status:     &fakeStatus{},
	}

	if _, err := New(valid); err != nil {
		t.Fatalf("valid options were refused: %v", err)
	}

	for name, mut := range map[string]func(*Options){
		"no secret":     func(o *Options) { o.Secret = "" },
		"no controller": func(o *Options) { o.Controller = nil },
		"no status":     func(o *Options) { o.Status = nil },
	} {
		o := valid
		mut(&o)
		if _, err := New(o); err == nil {
			t.Errorf("%s was accepted", name)
		}
	}
}

func TestListenBindsLoopbackOnly(t *testing.T) {
	s, err := New(Options{Secret: secret, Controller: &fakeController{}, Status: &fakeStatus{}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	port, err := s.Listen()
	if err != nil {
		t.Fatalf("Listen: %v", err)
	}
	// Serve was never called, so http.Server does not own the listener and Shutdown would
	// not close it.
	defer func() { _ = s.ln.Close() }()

	if port == 0 {
		t.Fatal("Listen returned port 0; the real port is what Electron is told")
	}
	addr := s.ln.Addr().String()
	if !strings.HasPrefix(addr, "127.0.0.1:") {
		t.Errorf("bound to %q; the control API must never leave loopback", addr)
	}
}

func TestServeBeforeListenIsAnError(t *testing.T) {
	s, err := New(Options{Secret: secret, Controller: &fakeController{}, Status: &fakeStatus{}})
	if err != nil {
		t.Fatalf("New: %v", err)
	}
	if err := s.Serve(); err == nil {
		t.Error("Serve without Listen must be an error, not a silent no-op")
	}
}
