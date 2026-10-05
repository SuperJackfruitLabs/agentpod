package descriptor

import (
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
)

// configJournalDirName is the node's own, harness-opaque state directory
// inside a profile — the same ".agentpod" internal/hermeslive's own journal
// (internal/hermeslive/operation.go, see its doc comment) already uses for
// exactly this reason: Hermes rewrites and migrates its own config directory
// (it carries a `_config_version` it manages), so a receipt that must
// survive every such rewrite cannot live anywhere under that directory.
// ".agentpod" is a sibling the harness does not read, write, or know about.
const configJournalDirName = ".agentpod"

// configJournalFileName holds every config-apply receipt for one station, in
// one file — not one file per operation the way hermeslive's plugin-operation
// journal is laid out, because a station's config operations are expected to
// be few and this avoids a second directory of growing, hard-to-garbage-collect
// per-operation files for a feature with no plugin-style install/uninstall
// lifecycle to key one by.
const configJournalFileName = "config-operations.json"

// ErrConfigOperationNotFound is returned by ApplyConfig and InspectConfig when
// asked about an operationID this station's journal has no record of at all —
// never a silently fabricated plan standing in for a review that never
// happened.
var ErrConfigOperationNotFound = errors.New("config: no such operation")

// configJournalLock serializes every read-then-maybe-write sequence across
// every station's journal this process touches, mirroring the single
// process-wide lock hermeslive.Journal.Lock holds for its own operations:
// two goroutines racing a plan-then-apply on the same station must not
// interleave.
var configJournalLock sync.Mutex

// configJournal is the per-station record of PlanConfig and ApplyConfig
// outcomes, keyed by operationID.
type configJournal struct {
	path string // profileDir/.agentpod/config-operations.json
}

// openConfigJournal returns the journal for the station whose profile
// directory is profileDir.
func openConfigJournal(profileDir string) configJournal {
	return configJournal{path: filepath.Join(profileDir, configJournalDirName, configJournalFileName)}
}

// lock holds the journal for a read-plan-apply sequence; the caller must call
// the returned func exactly once, however it returns.
func (configJournal) lock() func() {
	configJournalLock.Lock()
	return configJournalLock.Unlock
}

// readAll loads every receipt this station's journal holds, or an empty map
// if the journal file does not exist yet — a station that has never had a
// config plan written is not an error, only an empty journal.
func (j configJournal) readAll() (map[string]ConfigReceipt, error) {
	data, err := os.ReadFile(j.path)
	if errors.Is(err, fs.ErrNotExist) {
		return map[string]ConfigReceipt{}, nil
	}
	if err != nil {
		return nil, err
	}
	entries := map[string]ConfigReceipt{}
	if err := json.Unmarshal(data, &entries); err != nil {
		return nil, fmt.Errorf("config: journal at %s is unreadable: %w", j.path, err)
	}
	return entries, nil
}

// read returns the receipt operationID was last recorded under, or
// ErrConfigOperationNotFound.
func (j configJournal) read(operationID string) (ConfigReceipt, error) {
	entries, err := j.readAll()
	if err != nil {
		return ConfigReceipt{}, err
	}
	receipt, ok := entries[operationID]
	if !ok {
		return ConfigReceipt{}, ErrConfigOperationNotFound
	}
	return receipt, nil
}

// write records receipt under its own Plan.OperationID, replacing whatever
// was there before, and leaves every other operation's receipt untouched.
// The whole file is rewritten atomically (temp file + rename, the same
// atomicWriteFile every other writer in this package uses) so a reader never
// observes a half-written journal.
func (j configJournal) write(receipt ConfigReceipt) error {
	entries, err := j.readAll()
	if err != nil {
		return err
	}
	entries[receipt.Plan.OperationID] = receipt
	data, err := json.MarshalIndent(entries, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(j.path), 0o700); err != nil {
		return err
	}
	return atomicWriteFile(j.path, data, 0o600)
}
