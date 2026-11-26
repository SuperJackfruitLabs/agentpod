// Package benchidentity manages the SSH key a station signs into a remote bench with.
//
// It is `gitidentity`'s key, copied rather than shared, and kept in its own directory
// (`<root>/bench-identities`), so that withdrawing a station's forge key never touches its bench
// key and the other way round. The two keys answer to different authorities: forge registers the
// git key for good, while SuperBench signs the bench key for one lease at a time.
//
// **The private key is generated here and never leaves the node.** The hub only ever sees the
// public half, which it relays to the bench host to be certified. The certificate that comes back
// is public too, and is written beside the key as `<key>-cert.pub`, where OpenSSH loads it on its
// own (no `CertificateFile` option is needed).
package benchidentity

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// keygenTimeout bounds `ssh-keygen`; generating an ed25519 key is instant.
const keygenTimeout = time.Minute

// Dir is where a node keeps its stations' bench keys, given the node's config root.
func Dir(root string) string { return filepath.Join(root, "bench-identities") }

// KeyPath is the private key for one station, named by its opaque, filesystem-safe id.
func KeyPath(root, stationID string) string { return filepath.Join(Dir(root), stationID) }

// CertPath is where the station's current certificate lives: OpenSSH's own `-cert.pub` name.
func CertPath(keyPath string) string { return keyPath + "-cert.pub" }

func stationFile(root, stationID string) string { return KeyPath(root, stationID) + ".station" }

// ValidStationID reports whether id can name a file in Dir: the hub's ids are opaque, and an id
// that could climb out of the directory or hide a second path is refused rather than cleaned.
func ValidStationID(id string) bool {
	if id == "" || len(id) > 128 || id == "." || id == ".." {
		return false
	}
	for _, c := range id {
		ok := c == '-' || c == '_' || c == '.' || (c >= '0' && c <= '9') || (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
		if !ok {
			return false
		}
	}
	return true
}

// EnsureKey returns the station's public key, generating the pair on first use.
//
// Idempotent: a renewal or a second attempt reuses the key, so a certificate already issued for
// it stays usable. The station key (`harness:name`) is recorded beside it for the operator.
func EnsureKey(root, stationID, stationKey string) (publicKey, keyPath string, created bool, err error) {
	if !ValidStationID(stationID) {
		return "", "", false, fmt.Errorf("benchidentity: invalid station id")
	}
	keyPath = KeyPath(root, stationID)
	pubPath := keyPath + ".pub"

	if data, readErr := os.ReadFile(pubPath); readErr == nil {
		if _, keyErr := os.Stat(keyPath); keyErr == nil {
			if err := writeStationFile(root, stationID, stationKey); err != nil {
				return "", "", false, err
			}
			return strings.TrimSpace(string(data)), keyPath, false, nil
		}
		// A public key without its private key signs nothing: start over.
		_ = os.Remove(pubPath)
	}

	if err := os.MkdirAll(Dir(root), 0o700); err != nil {
		return "", "", false, fmt.Errorf("benchidentity: create key directory: %w", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), keygenTimeout)
	defer cancel()
	// No passphrase: nothing is present to type one. The 0600 file in a 0700 directory, and a
	// certificate that expires with its lease, are what protect it.
	cmd := exec.CommandContext(ctx, "ssh-keygen", "-t", "ed25519", "-N", "",
		"-C", "agentpod bench station "+stationID, "-f", keyPath, "-q")
	if out, runErr := cmd.CombinedOutput(); runErr != nil {
		return "", "", false, fmt.Errorf("benchidentity: ssh-keygen: %w: %s", runErr, strings.TrimSpace(string(out)))
	}
	if err := os.Chmod(keyPath, 0o600); err != nil {
		return "", "", false, fmt.Errorf("benchidentity: secure key: %w", err)
	}
	if err := writeStationFile(root, stationID, stationKey); err != nil {
		return "", "", false, err
	}
	data, err := os.ReadFile(pubPath)
	if err != nil {
		return "", "", false, fmt.Errorf("benchidentity: read public key: %w", err)
	}
	return strings.TrimSpace(string(data)), keyPath, true, nil
}

func writeStationFile(root, stationID, stationKey string) error {
	if err := os.WriteFile(stationFile(root, stationID), []byte(stationKey), 0o600); err != nil {
		return fmt.Errorf("benchidentity: record station key: %w", err)
	}
	return nil
}
