package main

import (
	"bytes"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

const goodSecret = "6f1e0a2b3c4d5e6f7a8b9c0d1e2f3a4b" // 16 bytes of hex

func TestResolveSecret(t *testing.T) {
	t.Run("the flag is used when the environment is empty", func(t *testing.T) {
		t.Setenv(secretEnv, "")
		got, err := resolveSecret(goodSecret)
		if err != nil {
			t.Fatalf("resolveSecret: %v", err)
		}
		if got != goodSecret {
			t.Errorf("secret = %q", got)
		}
	})

	// A command line is visible to every process on the machine; the environment is not.
	t.Run("the environment wins over the flag", func(t *testing.T) {
		other := strings.Repeat("ab", 20)
		t.Setenv(secretEnv, other)
		got, err := resolveSecret(goodSecret)
		if err != nil {
			t.Fatalf("resolveSecret: %v", err)
		}
		if got != other {
			t.Errorf("secret = %q, want the environment value", got)
		}
	})

	t.Run("rejects the unusable", func(t *testing.T) {
		t.Setenv(secretEnv, "")
		for name, in := range map[string]string{
			"empty":     "",
			"not hex":   "this-is-not-hex-at-all!!",
			"odd digit": "abc",
			"too short": "0011223344556677", // 8 bytes
		} {
			if _, err := resolveSecret(in); err == nil {
				t.Errorf("%s (%q) was accepted", name, in)
			}
		}
	})
}

func TestParseLevel(t *testing.T) {
	for _, name := range []string{"debug", "info", "warn", "error"} {
		if _, err := parseLevel(name); err != nil {
			t.Errorf("parseLevel(%q): %v", name, err)
		}
	}
	if _, err := parseLevel("trace"); err == nil {
		t.Error("an unknown level was accepted")
	}

	d, _ := parseLevel("debug")
	e, _ := parseLevel("error")
	if d >= e {
		t.Errorf("levels are not ordered: debug=%d error=%d", d, e)
	}
}

// TestEmitterWritesNDJSON checks the framing Electron parses: one complete JSON object per
// line, nothing else on stdout.
func TestEmitterWritesNDJSON(t *testing.T) {
	var buf bytes.Buffer
	out := newEmitter(&buf, levelRank(protocol.LogInfo))

	out.emit(protocol.ReadyEvent(45123))
	out.emit(protocol.StatusEvent(protocol.EdgeStatus{State: protocol.StateStarting, UpdatedAt: 7}))
	out.logf(protocol.LogInfo, "listening on %s", "127.0.0.1:45123")
	out.logf(protocol.LogDebug, "this is below the configured level and must be dropped")

	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != 3 {
		t.Fatalf("wrote %d lines, want 3:\n%s", len(lines), buf.String())
	}

	var ready protocol.EdgeStdoutEvent
	if err := json.Unmarshal([]byte(lines[0]), &ready); err != nil {
		t.Fatalf("line 1 is not JSON: %v (%s)", err, lines[0])
	}
	if ready.Type != protocol.EventReady || ready.ControlPort == nil || *ready.ControlPort != 45123 {
		t.Errorf("first event = %s, want the ready event with the real port", lines[0])
	}

	var status protocol.EdgeStdoutEvent
	if err := json.Unmarshal([]byte(lines[1]), &status); err != nil {
		t.Fatalf("line 2 is not JSON: %v (%s)", err, lines[1])
	}
	if status.Type != protocol.EventStatus || status.Status == nil || status.Status.State != protocol.StateStarting {
		t.Errorf("second event = %s", lines[1])
	}

	var logged protocol.EdgeStdoutEvent
	if err := json.Unmarshal([]byte(lines[2]), &logged); err != nil {
		t.Fatalf("line 3 is not JSON: %v (%s)", err, lines[2])
	}
	if logged.Type != protocol.EventLog || logged.Message == nil ||
		*logged.Message != "listening on 127.0.0.1:45123" {
		t.Errorf("third event = %s", lines[2])
	}
}

// TestEmitterIsSerialised: two goroutines interleaving halfway through a JSON object would
// produce a line Electron cannot parse and cannot resynchronise from.
func TestEmitterIsSerialised(t *testing.T) {
	var buf bytes.Buffer
	out := newEmitter(&buf, levelRank(protocol.LogDebug))

	const writers = 8
	const each = 50

	var wg sync.WaitGroup
	for i := 0; i < writers; i++ {
		wg.Add(1)
		go func(n int) {
			defer wg.Done()
			for j := 0; j < each; j++ {
				out.logf(protocol.LogInfo, "writer %d line %d", n, j)
			}
		}(i)
	}
	wg.Wait()

	lines := strings.Split(strings.TrimRight(buf.String(), "\n"), "\n")
	if len(lines) != writers*each {
		t.Fatalf("wrote %d lines, want %d", len(lines), writers*each)
	}
	for i, line := range lines {
		var ev protocol.EdgeStdoutEvent
		if err := json.Unmarshal([]byte(line), &ev); err != nil {
			t.Fatalf("line %d is not a complete JSON object: %v (%s)", i+1, err, line)
		}
	}
}
