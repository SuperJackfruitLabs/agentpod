package benchremote

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"path/filepath"
	"strings"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchlaunch"
)

// JournalVersion names the remote launch's journal document.
const JournalVersion = "agentpod.remote-launch.v1"

// Journal is the remote launch's durable per-bench record, one document per
// bench key at <Root>/<benchKey>.json beside its lock file. Root is
// <StateRoot>/remote and must be a private (0700) directory; each document is
// a 0600 file written through benchjournal.WriteAtomic. The shared steps
// (create, lease, checkpoint, stop, release) hold exact request and reply
// bytes, which carry the lease token, exactly as the registered launch keeps
// them. The remote state beside them never holds a token, a certificate or a
// key: only the public key's fingerprint, benchd's remote execution ID and the
// agent's report.
type Journal struct{ Root string }

// JournalRoot is the remote launch's journal directory under a registry's state root.
func JournalRoot(stateRoot string) string { return filepath.Join(stateRoot, "remote") }

func (j Journal) launch() benchlaunch.Journal {
	return benchlaunch.Journal{Root: j.Root, Version: JournalVersion}
}

// state is what the remote launch journals beside the shared steps.
type state struct {
	// Fingerprint is the SHA256 fingerprint of the one public key this record
	// issues certificates for. A different key is refused.
	Fingerprint string `json:"public_key_fingerprint,omitempty"`
	// ExecutionID is benchd's remote execution on the lease, as last seen
	// after a certificate was issued. benchd starts a new one after a restart
	// or a fenced checkpoint; the latest is the one a completion names.
	ExecutionID string `json:"execution_id,omitempty"`
	// Finishing is set while a finish is in flight: an attach is refused, so
	// no certificate is issued for a lease that is being checkpointed and
	// released. A dirty tree clears it again.
	Finishing bool `json:"finishing,omitempty"`
	// Report is the canonical bytes of the agent's report (handoff and
	// outcome). It may change until the finishing checkpoint succeeds.
	Report []byte `json:"report,omitempty"`
	// Checkpointed is set once the finishing checkpoint succeeded: from then
	// on only the same report finishes.
	Checkpointed bool `json:"checkpointed,omitempty"`
}

func decodeState(raw json.RawMessage) (state, error) {
	var s state
	if len(raw) == 0 {
		return s, nil
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if d.Decode(&s) != nil {
		return state{}, benchdispatch.ErrInvalid
	}
	return s, nil
}

func (s state) encode() json.RawMessage {
	raw, _ := json.Marshal(s)
	return raw
}

// Fingerprint is an OpenSSH public key line's SHA256 fingerprint
// ("SHA256:" and the unpadded base64 of the key blob's digest), as ssh-keygen
// prints it. It reads only the key type and blob; a comment is ignored.
func Fingerprint(publicKey string) (string, error) {
	fields := strings.Fields(publicKey)
	if len(fields) < 2 || len(publicKey) > MaxPublicKey {
		return "", benchdispatch.ErrInvalid
	}
	blob, err := base64.StdEncoding.DecodeString(fields[1])
	if err != nil || len(blob) < 4 {
		return "", benchdispatch.ErrInvalid
	}
	// The blob starts with its own length-prefixed key type, which must be the line's.
	n := int(blob[0])<<24 | int(blob[1])<<16 | int(blob[2])<<8 | int(blob[3])
	if n <= 0 || 4+n > len(blob) || string(blob[4:4+n]) != fields[0] {
		return "", benchdispatch.ErrInvalid
	}
	sum := sha256.Sum256(blob)
	return "SHA256:" + base64.RawStdEncoding.EncodeToString(sum[:]), nil
}
