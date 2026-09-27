// Package gitidentity manages the SSH key a station pushes with.
//
// `charter → decisions/2026-09-27-which-side-is-primary-is-a-repositorys-property.md` makes
// `super-jackfruit-website` forge-primary, so an agent that writes code needs a forge identity.
// `estate → docs/2026-09-21-forge.md` §7 settled the shape — one account per agent — and this
// adds one key per station beneath it, so a station's access can be withdrawn without disturbing
// the agent's other stations.
//
// **The private key is generated here and never leaves the node.** The hub registers only the
// public half and stores forge's key id; it holds no secret at all. That is how forge's own push
// mirror works, and it means a hub compromise cannot leak a key the hub never had.
//
// **The key lives in the node's config directory, never in a station's workspace.** A key in the
// workspace is a key the agent can read, print, commit by accident, or carry into a handoff — and
// the workspace is the one directory whose contents leave the machine.
package gitidentity

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// keygenTimeout bounds `ssh-keygen`. Generating an ed25519 key is instant; a minute is the point
// at which something is wrong rather than slow.
const keygenTimeout = time.Minute

// Dir is where a node keeps its stations' keys, given the node's config root.
func Dir(root string) string {
	return filepath.Join(root, "git-identities")
}

// KeyPath is the private key for one station.
//
// Named by station id, which is opaque and filesystem-safe, rather than by the agent's handle: a
// handle can be renamed, and a key whose filename stopped matching its station is a key nobody
// will find to remove.
func KeyPath(root, stationID string) string {
	return filepath.Join(Dir(root), stationID)
}

// SSHCommand is the GIT_SSH_COMMAND that uses one station's key and nothing else.
//
// `IdentitiesOnly=yes` is not decoration. Without it ssh offers every identity it can find —
// an agent, a developer's own key, anything in ~/.ssh — and forge closes the connection after too
// many failures, with an error that names none of them.
//
// `StrictHostKeyChecking=accept-new` trusts forge's host key the first time and pins it after, so
// a first push does not hang on a prompt no agent can answer, while a later change still fails.
func SSHCommand(keyPath string) string {
	return fmt.Sprintf(
		"ssh -i %s -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o BatchMode=yes",
		keyPath,
	)
}

// EnsureKey returns the station's public key, generating the pair on first use.
//
// Idempotent on purpose: regenerating would silently orphan the key already registered on forge,
// which the hub could then never match to this station again — it would keep working until
// somebody revoked a key that was no longer the one in use.
func EnsureKey(root, stationID string) (publicKey string, keyPath string, created bool, err error) {
	keyPath = KeyPath(root, stationID)
	pubPath := keyPath + ".pub"

	if data, statErr := os.ReadFile(pubPath); statErr == nil {
		if _, keyErr := os.Stat(keyPath); keyErr == nil {
			return strings.TrimSpace(string(data)), keyPath, false, nil
		}
		// A public key with no private key is not a usable identity. Removing both and starting
		// over beats returning a key nothing can sign with.
		_ = os.Remove(pubPath)
	}

	if err := os.MkdirAll(Dir(root), 0o700); err != nil {
		return "", "", false, fmt.Errorf("gitidentity: create key directory: %w", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), keygenTimeout)
	defer cancel()

	// `-N ""` — no passphrase, because nothing is present to type one. What protects the key is
	// the 0600 file in a 0700 directory the node owns, and the fact that it can be revoked on its
	// own from forge.
	cmd := exec.CommandContext(ctx, "ssh-keygen",
		"-t", "ed25519",
		"-N", "",
		"-C", fmt.Sprintf("agentpod station %s", stationID),
		"-f", keyPath,
		"-q",
	)
	if out, runErr := cmd.CombinedOutput(); runErr != nil {
		return "", "", false, fmt.Errorf("gitidentity: ssh-keygen: %w: %s", runErr, strings.TrimSpace(string(out)))
	}

	// ssh-keygen already writes 0600, but a umask or a pre-existing file can leave it otherwise,
	// and ssh refuses a key others can read — better to fail here than at the first push.
	if err := os.Chmod(keyPath, 0o600); err != nil {
		return "", "", false, fmt.Errorf("gitidentity: secure key: %w", err)
	}

	data, err := os.ReadFile(pubPath)
	if err != nil {
		return "", "", false, fmt.Errorf("gitidentity: read public key: %w", err)
	}
	return strings.TrimSpace(string(data)), keyPath, true, nil
}

// Remove deletes a station's key from this node. The forge side is the hub's to withdraw.
func Remove(root, stationID string) error {
	keyPath := KeyPath(root, stationID)
	for _, p := range []string{keyPath, keyPath + ".pub"} {
		if err := os.Remove(p); err != nil && !os.IsNotExist(err) {
			return fmt.Errorf("gitidentity: remove %s: %w", p, err)
		}
	}
	return nil
}
