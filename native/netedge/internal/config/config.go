// Package config loads and saves netedge's on-disk configuration.
//
// The one rule this package exists to enforce: **no plaintext secret is ever written here**.
// The Headscale pre-authentication key and the DNS provider API token live encrypted under
// Electron's safeStorage (Windows DPAPI) and are handed to netedge already decrypted, either
// as part of a PUT /edge/config body or at spawn time. Persisting them again from Go would
// create a second, unprotected copy on disk — exactly what rule 1 of design spec section 3
// forbids. Save therefore strips them, and Load returns a configuration whose secret fields
// are empty until Electron supplies them.
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"github.com/sadrazkh/localcast/netedge/internal/protocol"
)

// Version is the schema version of the file. It is written so a future netedge can migrate
// rather than guess.
const Version = 1

// FileName is the default basename inside the state directory.
const FileName = "netedge.json"

// File is the whole on-disk document.
type File struct {
	Version int                    `json:"version"`
	Network protocol.NetworkConfig `json:"network"`
}

// Default returns the configuration a first run starts from: the default coordination
// server, tailnet only, certificates from the control plane. This is the zero-input path
// described in design spec 2.2 and it must never need the user to type anything.
func Default() File {
	cfg := protocol.NetworkConfig{
		Mode:         protocol.ModeDefault,
		CertStrategy: protocol.CertControlPlane,
	}
	cfg.ApplyDefaults()
	return File{Version: Version, Network: cfg}
}

// String renders the file with every secret redacted, so a `log.Printf("%v", f)` anywhere in
// the tree cannot leak one.
func (f File) String() string {
	return fmt.Sprintf("config.File{version=%d network=%s}", f.Version, f.Network.String())
}

// DefaultPath returns the config path inside a state directory.
func DefaultPath(stateDir string) string {
	return filepath.Join(stateDir, FileName)
}

// Load reads path.
//
// A missing file is not an error: it is what the very first run looks like, and returning
// Default() there is the difference between "install and click once" and "install and see an
// error before anything has happened".
func Load(path string) (File, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, fs.ErrNotExist) {
			return Default(), nil
		}
		return File{}, fmt.Errorf("read config %s: %w", path, err)
	}

	var f File
	if err := json.Unmarshal(raw, &f); err != nil {
		return File{}, fmt.Errorf("parse config %s: %w", path, err)
	}

	// A file written before versioning, or hand-edited without the field.
	if f.Version == 0 {
		f.Version = Version
	}
	if f.Version > Version {
		return File{}, fmt.Errorf("config %s is version %d; this build understands up to %d",
			path, f.Version, Version)
	}

	// Defence in depth: if an older build or a hand edit did leave a secret in the file, we
	// drop it rather than adopt it. Loading it would mean this process trusts a credential
	// that never went through DPAPI, and Save would then keep rewriting it.
	if f.Network.HasSecrets() {
		f.Network = f.Network.WithoutSecrets()
	}

	f.Network.ApplyDefaults()
	return f, nil
}

// Save writes path atomically with mode 0600, having stripped both secrets.
//
// The write goes to a temporary file in the same directory and is renamed into place, so a
// crash or a power cut leaves either the old file or the new one — never a truncated file
// that fails to parse on the next start.
func Save(path string, f File) error {
	f.Version = Version
	f.Network.ApplyDefaults()
	f.Network = f.Network.WithoutSecrets()

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create config directory %s: %w", dir, err)
	}

	raw, err := json.MarshalIndent(f, "", "  ")
	if err != nil {
		return fmt.Errorf("encode config: %w", err)
	}
	raw = append(raw, '\n')

	tmp, err := os.CreateTemp(dir, filepath.Base(path)+".*.tmp")
	if err != nil {
		return fmt.Errorf("create temp config in %s: %w", dir, err)
	}
	tmpName := tmp.Name()
	// Best effort on every failure path below: an orphaned temp file is noise, but leaving
	// the real file half written is data loss.
	defer func() {
		_ = os.Remove(tmpName)
	}()

	// os.CreateTemp already creates with 0600; this is belt and braces for a umask-free
	// future. It is best effort because Chmod maps onto Windows ACLs imperfectly and a
	// failure there is not worth aborting the write.
	_ = tmp.Chmod(0o600)

	if _, err := tmp.Write(raw); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("write temp config %s: %w", tmpName, err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("sync temp config %s: %w", tmpName, err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("close temp config %s: %w", tmpName, err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("replace config %s: %w", path, err)
	}
	return nil
}

// AssertNoSecrets reports an error if raw contains either secret verbatim. It is used by the
// test that guards the disk half of the "never store a plaintext secret" rule, and is
// exported so an integration test elsewhere can make the same assertion about a real file.
func AssertNoSecrets(raw []byte, secrets ...string) error {
	text := string(raw)
	for _, s := range secrets {
		if s == "" {
			continue
		}
		if strings.Contains(text, s) {
			return fmt.Errorf("a secret of length %d was written to disk", len(s))
		}
	}
	return nil
}
