package config

import (
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

const (
	testAuthKey  = "tskey-auth-kFbb9Vi7CNTRL-thisMustNeverReachDisk"
	testDNSToken = "cf_live_thisMustNeverReachDiskEither"
)

func secretful() File {
	return File{
		Version: Version,
		Network: protocol.NetworkConfig{
			Mode:         protocol.ModeCustom,
			ControlURL:   "https://hs.example.com",
			AuthKey:      testAuthKey,
			Expose:       protocol.ExposeTailnet,
			CertStrategy: protocol.CertDNS01,
			CertDomain:   "cast.example.com",
			DNSProvider:  protocol.DNSProviderCloudflare,
			DNSAPIToken:  testDNSToken,
			Hostname:     protocol.DefaultHostname,
		},
	}
}

// TestSaveStripsSecrets is the disk half of the "secrets are never stored in plaintext"
// rule. It reads the raw bytes rather than the parsed struct on purpose: a bug that wrote
// the key under a different JSON key would still fail this.
func TestSaveStripsSecrets(t *testing.T) {
	path := filepath.Join(t.TempDir(), "netedge.json")

	if err := Save(path, secretful()); err != nil {
		t.Fatalf("save: %v", err)
	}

	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if err := AssertNoSecrets(raw, testAuthKey, testDNSToken); err != nil {
		t.Fatalf("%v\nfile was:\n%s", err, raw)
	}
	if strings.Contains(string(raw), protocol.RedactedPlaceholder) {
		t.Errorf("the placeholder was persisted; secrets must be absent, not redacted:\n%s", raw)
	}

	// Everything that is not a secret must survive, or switching to Headscale would forget
	// the control URL on the next start.
	var back File
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatalf("parse written file: %v", err)
	}
	if back.Network.ControlURL != "https://hs.example.com" {
		t.Errorf("controlUrl = %q", back.Network.ControlURL)
	}
	if back.Network.CertStrategy != protocol.CertDNS01 {
		t.Errorf("certStrategy = %q", back.Network.CertStrategy)
	}
	if back.Network.DNSProvider != protocol.DNSProviderCloudflare {
		t.Errorf("dnsProvider = %q", back.Network.DNSProvider)
	}
	if back.Version != Version {
		t.Errorf("version = %d, want %d", back.Version, Version)
	}

	// Save must not mutate the caller's copy: it takes File by value, and the caller still
	// needs the live secrets to start the node.
	f := secretful()
	if err := Save(path, f); err != nil {
		t.Fatalf("save: %v", err)
	}
	if f.Network.AuthKey != testAuthKey || f.Network.DNSAPIToken != testDNSToken {
		t.Error("Save stripped the caller's in-memory secrets")
	}

	if runtime.GOOS != "windows" {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("stat: %v", err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("mode = %o, want 600", perm)
		}
	}
}

// TestStringRedactsSecrets is the log half of the same rule.
func TestStringRedactsSecrets(t *testing.T) {
	f := secretful()
	s := f.String()

	if strings.Contains(s, testAuthKey) {
		t.Errorf("auth key leaked into String(): %s", s)
	}
	if strings.Contains(s, testDNSToken) {
		t.Errorf("dns token leaked into String(): %s", s)
	}
	if !strings.Contains(s, protocol.RedactedPlaceholder) {
		t.Errorf("String() has no redaction marker: %s", s)
	}
	// Non-secret context is the whole point of logging it at all.
	if !strings.Contains(s, "hs.example.com") {
		t.Errorf("String() dropped the control URL: %s", s)
	}
}

func TestLoadMissingFileReturnsDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "does-not-exist.json")

	f, err := Load(path)
	if err != nil {
		t.Fatalf("a missing config must not be an error, got %v", err)
	}
	if f.Network.Mode != protocol.ModeDefault {
		t.Errorf("mode = %q, want default", f.Network.Mode)
	}
	if f.Network.CertStrategy != protocol.CertControlPlane {
		t.Errorf("certStrategy = %q, want control-plane", f.Network.CertStrategy)
	}
	if f.Network.Expose != protocol.ExposeTailnet {
		t.Errorf("expose = %q, want tailnet", f.Network.Expose)
	}
	if f.Network.Hostname != protocol.DefaultHostname {
		t.Errorf("hostname = %q", f.Network.Hostname)
	}
	if err := f.Network.Validate(); err != nil {
		t.Errorf("the first-run default must be a valid configuration: %v", err)
	}
}

// TestLoadDropsSecretsFoundOnDisk covers the case where an older build, or a hand edit, left
// a plaintext key in the file. Adopting it would mean trusting a credential that never went
// through DPAPI.
func TestLoadDropsSecretsFoundOnDisk(t *testing.T) {
	path := filepath.Join(t.TempDir(), "netedge.json")
	raw, err := json.Marshal(secretful())
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}

	f, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if f.Network.HasSecrets() {
		t.Errorf("Load adopted an on-disk secret: %s", f.String())
	}
	if f.Network.ControlURL != "https://hs.example.com" {
		t.Errorf("Load dropped a non-secret field: %s", f.String())
	}
}

func TestLoadRejectsNewerVersion(t *testing.T) {
	path := filepath.Join(t.TempDir(), "netedge.json")
	if err := os.WriteFile(path, []byte(`{"version":99,"network":{"mode":"default"}}`), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("a config from a newer build must be refused, not silently reinterpreted")
	}
}

func TestLoadRejectsGarbage(t *testing.T) {
	path := filepath.Join(t.TempDir(), "netedge.json")
	if err := os.WriteFile(path, []byte("not json"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if _, err := Load(path); err == nil {
		t.Fatal("a corrupt config must be an error, not silently replaced by defaults")
	}
}

func TestSaveLoadRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "netedge.json")

	want := secretful()
	if err := Save(path, want); err != nil {
		t.Fatalf("save: %v", err)
	}
	got, err := Load(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}

	if got.Network != want.Network.WithoutSecrets() {
		t.Errorf("round trip\n got %s\nwant %s", got.Network.String(), want.Network.WithoutSecrets().String())
	}

	// Overwriting must replace, not append or fail, and must leave no temp files behind.
	if err := Save(path, Default()); err != nil {
		t.Fatalf("overwrite: %v", err)
	}
	entries, err := os.ReadDir(filepath.Dir(path))
	if err != nil {
		t.Fatalf("readdir: %v", err)
	}
	for _, e := range entries {
		if strings.HasSuffix(e.Name(), ".tmp") {
			t.Errorf("temp file left behind: %s", e.Name())
		}
	}
}

func TestDefaultPath(t *testing.T) {
	if got, want := DefaultPath("C:\\state"), filepath.Join("C:\\state", FileName); got != want {
		t.Errorf("DefaultPath = %q, want %q", got, want)
	}
}
