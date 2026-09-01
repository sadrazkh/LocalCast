package edge

import (
	"fmt"
	"sync"
	"time"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

// subscriberBuffer is how many snapshots a slow subscriber may fall behind before the store
// starts coalescing. Every message is a full snapshot, so dropping the oldest costs nothing.
const subscriberBuffer = 8

// legalTransitions is the state machine the tray dot follows.
//
// Three targets are legal from anywhere and are therefore not repeated in the table:
// StateError (anything can fail), StateStopped (shutdown), and StateStarting (restart in
// place, which design spec 2.4 requires to work from any state without exiting the process).
// A transition to the current state is also always legal, so a re-publish that only changes
// the peer count is not rejected.
var legalTransitions = map[protocol.EdgeState][]protocol.EdgeState{
	protocol.StateStopped: {},
	protocol.StateStarting: {
		protocol.StateLoginRequired,
		protocol.StateConnecting,
	},
	protocol.StateLoginRequired: {
		protocol.StateConnecting,
		protocol.StateObtainingCertificate,
		// Straight to connected, with no certificate step in between, is how the funnel and
		// external-proxy paths finish: neither holds a certificate of its own, so bringUp goes
		// from "the user signed in" to "serving" in one move. While this was missing,
		// SetConnected returned an error and changed nothing, so a node that was up and
		// proxying traffic still showed a sign-in prompt — with a URL that had already been
		// used — for the rest of the process's life.
		protocol.StateConnected,
	},
	protocol.StateConnecting: {
		// Back to login-required is reachable: a node whose key was revoked while it was
		// connecting reports NeedsLogin again.
		protocol.StateLoginRequired,
		protocol.StateObtainingCertificate,
		protocol.StateConnected,
	},
	protocol.StateObtainingCertificate: {
		protocol.StateConnected,
		// A DNS-01 issuance takes minutes, and both a revoked key and POST /edge/logout can
		// land inside that window. While this was missing, signing out during an issuance
		// answered 204 and changed nothing on screen.
		protocol.StateLoginRequired,
	},
	protocol.StateConnected: {
		// A renewal re-enters obtaining-certificate; a dropped tailnet re-enters connecting.
		protocol.StateObtainingCertificate,
		protocol.StateConnecting,
		// A key that expires after the node has connected drops the backend back to
		// NeedsLogin, and POST /edge/logout puts it there deliberately. This is the mirror
		// image of the login-required -> connected gap above and it lies in the more dangerous
		// direction: while it was missing, the tray went on showing a green dot for a node
		// that had stopped carrying traffic. Edge.watch is what notices the expiry; nothing
		// else is looking, because waitForRunning returned once the node first came up.
		protocol.StateLoginRequired,
	},
	protocol.StateError: {},
}

// universalTargets are legal from every state. See legalTransitions.
var universalTargets = []protocol.EdgeState{
	protocol.StateError,
	protocol.StateStopped,
	protocol.StateStarting,
}

// CanTransition reports whether the state machine permits from → to.
func CanTransition(from, to protocol.EdgeState) bool {
	if !from.Valid() || !to.Valid() {
		return false
	}
	if from == to {
		return true
	}
	for _, t := range universalTargets {
		if to == t {
			return true
		}
	}
	for _, t := range legalTransitions[from] {
		if to == t {
			return true
		}
	}
	return false
}

// StatusStore holds the single EdgeStatus and fans changes out to the SSE endpoint and the
// stdout emitter. It is the only mutable state shared between the tsnet goroutines and the
// control API, so it owns its own lock and hands out copies.
type StatusStore struct {
	now func() time.Time

	mu     sync.Mutex
	cur    protocol.EdgeStatus
	subs   map[int]chan protocol.EdgeStatus
	nextID int
}

// NewStatusStore returns a store in StateStopped. now is injectable so tests do not depend
// on the wall clock.
func NewStatusStore(now func() time.Time) *StatusStore {
	if now == nil {
		now = time.Now
	}
	s := &StatusStore{
		now:  now,
		subs: make(map[int]chan protocol.EdgeStatus),
	}
	s.cur = protocol.EdgeStatus{
		State:     protocol.StateStopped,
		UpdatedAt: now().UnixMilli(),
	}
	return s
}

// Get returns a copy of the current status.
func (s *StatusStore) Get() protocol.EdgeStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.cur
}

// Subscribe returns a channel of snapshots and a function that unsubscribes and closes it.
// The caller must call the returned function, normally with defer.
func (s *StatusStore) Subscribe() (<-chan protocol.EdgeStatus, func()) {
	s.mu.Lock()
	defer s.mu.Unlock()

	id := s.nextID
	s.nextID++
	ch := make(chan protocol.EdgeStatus, subscriberBuffer)
	s.subs[id] = ch

	var once sync.Once
	cancel := func() {
		once.Do(func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if c, ok := s.subs[id]; ok {
				delete(s.subs, id)
				close(c)
			}
		})
	}
	return ch, cancel
}

// Update applies mut to the current status without changing the state, then publishes. Use
// it for facts that do not move the machine, such as the peer count.
func (s *StatusStore) Update(mut func(*protocol.EdgeStatus)) {
	s.mu.Lock()
	next := s.cur
	if mut != nil {
		mut(&next)
	}
	next.State = s.cur.State
	s.commitLocked(next)
	s.mu.Unlock()
}

// Transition moves to a new state, applying mut to the snapshot first.
//
// It returns an error and changes nothing when the transition is not in the table. The
// caller logs that: a rejected transition is a bug in the caller, and applying it anyway
// would let the UI show, say, "connected" for a node that never authenticated.
func (s *StatusStore) Transition(to protocol.EdgeState, mut func(*protocol.EdgeStatus)) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if !CanTransition(s.cur.State, to) {
		return fmt.Errorf("illegal edge state transition %s -> %s", s.cur.State, to)
	}

	next := s.cur
	next.State = to
	clearStaleFields(&next, to)
	if mut != nil {
		mut(&next)
		// mut must not smuggle in a different state.
		next.State = to
	}
	s.commitLocked(next)
	return nil
}

// clearStaleFields drops the fields that do not belong to the state being entered.
//
// Without this the UI keeps showing whatever was last true: a login URL that has already
// been consumed, or the error from a failure two restarts ago. Every field here is one the
// renderer displays directly, so a stale value is a lie on screen.
func clearStaleFields(st *protocol.EdgeStatus, to protocol.EdgeState) {
	if to != protocol.StateLoginRequired {
		st.LoginURL = nil
	}
	if to != protocol.StateError {
		st.ErrorCode = nil
		st.ErrorMessage = nil
	}
	if to == protocol.StateStopped || to == protocol.StateStarting {
		st.Host = nil
		st.FunnelURL = nil
		st.CertExpiresAt = nil
		st.Peers = 0
	}
}

// commitLocked stamps and publishes. The caller holds s.mu.
func (s *StatusStore) commitLocked(next protocol.EdgeStatus) {
	next.UpdatedAt = s.now().UnixMilli()
	s.cur = next

	for _, ch := range s.subs {
		select {
		case ch <- next:
		default:
			// The subscriber is behind. Snapshots supersede one another, so drop the oldest
			// and push the newest rather than blocking a tsnet goroutine on an SSE client
			// that stopped reading — a phone that locked its screen mid-stream is the
			// ordinary case, not the exceptional one.
			select {
			case <-ch:
			default:
			}
			select {
			case ch <- next:
			default:
			}
		}
	}
}

// ─── convenience wrappers ────────────────────────────────────────────────────
//
// These exist so callers never spell a state string inline and never forget to clear a
// field. Each returns the Transition error for the caller to log.

// SetStarting enters the state a fresh generation begins in.
func (s *StatusStore) SetStarting() error {
	return s.Transition(protocol.StateStarting, nil)
}

// SetConnecting means the node is talking to the control plane.
func (s *StatusStore) SetConnecting() error {
	return s.Transition(protocol.StateConnecting, nil)
}

// SetLoginRequired publishes the interactive login URL. Electron opens it; netedge never
// launches a browser itself.
func (s *StatusStore) SetLoginRequired(loginURL string) error {
	return s.Transition(protocol.StateLoginRequired, func(st *protocol.EdgeStatus) {
		if loginURL != "" {
			st.LoginURL = protocol.Ptr(loginURL)
		}
	})
}

// SetObtainingCertificate is a distinct state from connecting because it can take minutes on
// DNS-01 and the user deserves to know which of the two is happening.
func (s *StatusStore) SetObtainingCertificate() error {
	return s.Transition(protocol.StateObtainingCertificate, nil)
}

// SetConnected publishes the reachable identity. funnelURL is empty in tailnet mode and
// certExpiresAt is nil when the strategy does not hold a certificate of its own.
func (s *StatusStore) SetConnected(host, funnelURL string, certExpiresAt *int64) error {
	return s.Transition(protocol.StateConnected, func(st *protocol.EdgeStatus) {
		if host != "" {
			st.Host = protocol.Ptr(host)
		}
		if funnelURL != "" {
			st.FunnelURL = protocol.Ptr(funnelURL)
		} else {
			st.FunnelURL = nil
		}
		st.CertExpiresAt = certExpiresAt
	})
}

// SetError publishes a stable machine code plus prose. Clients branch on the code.
func (s *StatusStore) SetError(code, message string) error {
	return s.Transition(protocol.StateError, func(st *protocol.EdgeStatus) {
		st.ErrorCode = protocol.Ptr(code)
		st.ErrorMessage = protocol.Ptr(message)
	})
}

// SetStopped is the shutdown state.
func (s *StatusStore) SetStopped() error {
	return s.Transition(protocol.StateStopped, nil)
}

// SetPeers records how many tailnet peers are online.
//
// It publishes only on a change. The watcher calls this every thirty seconds for the life of
// the process, and a connected node whose peer count is stable would otherwise emit a status
// line to stdout, and to every SSE subscriber, twice a minute for ever.
func (s *StatusStore) SetPeers(n int) {
	s.mu.Lock()
	unchanged := s.cur.Peers == n
	s.mu.Unlock()
	if unchanged {
		return
	}
	s.Update(func(st *protocol.EdgeStatus) { st.Peers = n })
}

// SetHost records the MagicDNS name as soon as it is known, which is before the listener is
// up: the settings page can show the address while the certificate is still being fetched.
func (s *StatusStore) SetHost(host string) {
	s.Update(func(st *protocol.EdgeStatus) {
		if host == "" {
			st.Host = nil
			return
		}
		st.Host = protocol.Ptr(host)
	})
}

// SetCertExpiry records the current leaf's expiry. Like SetPeers, it publishes only on a
// change: renewals are months apart and the watcher runs every thirty seconds.
func (s *StatusStore) SetCertExpiry(at *int64) {
	s.mu.Lock()
	unchanged := sameInt64(s.cur.CertExpiresAt, at)
	s.mu.Unlock()
	if unchanged {
		return
	}
	s.Update(func(st *protocol.EdgeStatus) { st.CertExpiresAt = at })
}

// sameInt64 compares two optional timestamps by value. Comparing the pointers would report a
// change on every poll, because each poll builds a fresh one.
func sameInt64(a, b *int64) bool {
	switch {
	case a == nil && b == nil:
		return true
	case a == nil || b == nil:
		return false
	default:
		return *a == *b
	}
}
