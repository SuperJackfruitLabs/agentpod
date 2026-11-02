package configdoc

import (
	"os"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hostfs"
)

// ConflictReceipt is an UNRECORDED answer: it reports why an apply will not
// proceed without touching the journal, so the reviewed plan already on
// record (whatever it was) survives for a legitimate retry.
func ConflictReceipt(plan descriptor.ConfigPlan, code, message string) descriptor.ConfigReceipt {
	plan.Refusal = &descriptor.ConfigRefusal{Code: code, Message: message}
	return descriptor.ConfigReceipt{
		Plan:      plan,
		Phase:     "conflict",
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}
}

// rejectedSidecarPath returns where a lost race's intended edit is saved:
// configPath with ".agentpod-rejected" appended to its full name, so
// "config.yaml" becomes "config.yaml.agentpod-rejected" sitting right next
// to it.
func rejectedSidecarPath(configPath string) string {
	return configPath + ".agentpod-rejected"
}

// WriteRejectedSidecar saves intended beside configPath, atomically, using
// the same temp-file-plus-rename writer every other write in this package
// uses — this is not a second way to write a file, just a second path to
// write it to.
//
// This is the ONE place in the whole declared-configuration design that
// writes a file the harness itself does not own or ever read: every other
// write here lands inside a document the harness will itself parse at its
// next read, but a harness has no notion of ".agentpod-rejected" and never
// will. It exists purely as bookkeeping for a human to reconcile by hand —
// nothing in this system reads it back, so it is safe (and correct) for a
// later rejection of the same document to silently overwrite whatever an
// earlier one left here; there is no history to preserve, only a latest
// answer to the question "what did we intend to write."
func WriteRejectedSidecar(configPath string, intended []byte, mode os.FileMode) (string, error) {
	path := rejectedSidecarPath(configPath)
	if err := hostfs.AtomicWriteFile(path, intended, mode); err != nil {
		return path, err
	}
	return path, nil
}
