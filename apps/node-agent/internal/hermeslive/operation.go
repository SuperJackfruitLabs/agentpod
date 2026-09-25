package hermeslive

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// A plugin operation is the Console's way to run enable or disable (#553): the
// same plan and apply the CLI makes, reviewed in the Console before it runs.
// The node keeps a journal of each one in the profile, and the journal, not
// the hub, is the authority on what happened: a hub that lost track asks it.
//
//	.agentpod/plugin-operations/<operationId>.json   one receipt per operation

// OperationLimit bounds the journal. The hub keeps no more per station.
const OperationLimit = 256

const operationsDirName = "plugin-operations"

var operationID = regexp.MustCompile(`^[a-f0-9]{32}$`)

// OperationBinding names what an operation may touch. It is checked by the hub
// against the operation it created, so a plan cannot be replayed elsewhere.
type OperationBinding struct {
	NodeID     string `json:"nodeId"`
	StationKey string `json:"stationKey"`
	Harness    string `json:"harness"`
	Plugin     string `json:"plugin"`
}

// ConfigPreview is the configuration edit, for review. Before and after are
// named by hash, so the review is bound to the exact bytes.
type ConfigPreview struct {
	Path           string `json:"path"`
	BeforeSHA256   string `json:"beforeSHA256"`
	AfterSHA256    string `json:"afterSHA256"`
	Diff           string `json:"diff"`
	DiffTruncated  bool   `json:"diffTruncated"`
	RestoresBackup bool   `json:"restoresBackup"`
}

// OperationPlan is a Plan as the Console reviews it. A plan the node will not
// carry out still comes back, with Refusal saying why, so the reason reaches
// the operator as an answer rather than as a failed request.
type OperationPlan struct {
	SchemaVersion int              `json:"schemaVersion"`
	OperationID   string           `json:"operationId"`
	Action        string           `json:"action"`
	Binding       OperationBinding `json:"binding"`
	Version       string           `json:"version"`
	Gate          *Gate            `json:"gate"`
	Files         *string          `json:"files"`
	FilesDigest   string           `json:"filesDigest"`
	FileAction    *string          `json:"fileAction"`
	FileNames     []string         `json:"fileNames"`
	Config        *ConfigPreview   `json:"config"`
	NoOp          bool             `json:"noOp"`
	Notes         []string         `json:"notes"`
	Refusal       *string          `json:"refusal"`
	// Hermes reads plugins and configuration when a gateway starts. Nothing
	// here restarts one; the Console offers the station restart separately.
	RestartRequired bool   `json:"restartRequired"`
	CreatedAt       string `json:"createdAt"`
	PlanDigest      string `json:"planDigest"`
}

// OperationReceipt is the journal entry for one operation.
type OperationReceipt struct {
	Plan        OperationPlan `json:"plan"`
	Phase       string        `json:"phase"` // planned, applying, applied, conflict
	UpdatedAt   string        `json:"updatedAt"`
	CompletedAt *string       `json:"completedAt"`
	Error       *string       `json:"error"`
}

// ErrOperationNotFound is an operation this profile has no journal entry for.
var ErrOperationNotFound = errors.New("hermes-live: no such plugin operation")

const maxDiff = 16 << 10

// NewOperationPlan renders plan (or the refusal planErr) for review. The
// digest covers everything the review shows plus the plugin directory's
// fingerprint, so any change on disk after the review yields another digest.
func NewOperationPlan(binding OperationBinding, id, action string, gate *Gate, plan Plan, planErr error, createdAt string) OperationPlan {
	op := OperationPlan{
		SchemaVersion: 1, OperationID: id, Action: action, Binding: binding,
		Version: EmbeddedManifest().Version, Gate: gate, Notes: []string{}, FileNames: []string{},
		RestartRequired: true, CreatedAt: createdAt,
	}
	if planErr != nil {
		reason := boundedReason(planErr.Error())
		op.Refusal = &reason
		op.RestartRequired = false
		op.PlanDigest = digestOf(op)
		return op
	}
	files, fileAction := plan.Files, plan.FileAction
	op.Files, op.FileAction, op.FilesDigest = &files, &fileAction, plan.diskDigest
	if fileAction == "add" || fileAction == "replace" {
		op.FileNames = FileNames()
	}
	diff := DiffLines(string(plan.ConfigBefore), string(plan.ConfigAfter))
	truncated := len(diff) > maxDiff
	if truncated {
		diff = diff[:maxDiff]
	}
	op.Config = &ConfigPreview{
		Path: "config.yaml", BeforeSHA256: hash(plan.ConfigBefore), AfterSHA256: hash(plan.ConfigAfter),
		Diff: diff, DiffTruncated: truncated, RestoresBackup: plan.RestoresBackup,
	}
	op.NoOp = plan.NoOp
	op.RestartRequired = !plan.NoOp
	op.Notes = append(op.Notes, plan.Notes...)
	op.PlanDigest = digestOf(op)
	return op
}

func digestOf(op OperationPlan) string {
	op.PlanDigest = ""
	data, _ := json.Marshal(op)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func boundedReason(reason string) string {
	if len(reason) > 2048 {
		return reason[:2048]
	}
	return reason
}

// Journal is the operation record for one profile. Its lock serializes every
// operation in this process; apn's CLI does not use the journal.
type Journal struct {
	dir string
}

var journalLock sync.Mutex

func OpenJournal(profileDir string) Journal {
	return Journal{dir: filepath.Join(profileDir, stateDirName, operationsDirName)}
}

// Lock holds the journal for a read-plan-apply sequence.
func (Journal) Lock() func() {
	journalLock.Lock()
	return journalLock.Unlock
}

func (j Journal) path(id string) (string, error) {
	if !operationID.MatchString(id) {
		return "", fmt.Errorf("hermes-live: invalid operation id")
	}
	return filepath.Join(j.dir, id+".json"), nil
}

// Read returns the receipt for id, or ErrOperationNotFound.
func (j Journal) Read(id string) (OperationReceipt, error) {
	var receipt OperationReceipt
	path, err := j.path(id)
	if err != nil {
		return receipt, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, fs.ErrNotExist) {
		return receipt, ErrOperationNotFound
	}
	if err != nil {
		return receipt, err
	}
	if err := json.Unmarshal(data, &receipt); err != nil {
		return receipt, fmt.Errorf("hermes-live: plugin operation %s has an unreadable receipt", id)
	}
	return receipt, nil
}

// Write records receipt, making room for a new operation by dropping the
// oldest completed or refused ones once the journal is full.
func (j Journal) Write(receipt OperationReceipt) error {
	path, err := j.path(receipt.Plan.OperationID)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(j.dir, 0o700); err != nil {
		return err
	}
	if _, err := os.Stat(path); errors.Is(err, fs.ErrNotExist) {
		if err := j.prune(); err != nil {
			return err
		}
	}
	data, err := json.MarshalIndent(receipt, "", "  ")
	if err != nil {
		return err
	}
	return writeAtomic(path, append(data, '\n'), 0o600)
}

func (j Journal) prune() error {
	entries, err := os.ReadDir(j.dir)
	if err != nil {
		return err
	}
	type entry struct {
		name string
		at   time.Time
	}
	var finished []entry
	count := 0
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".json") || !operationID.MatchString(strings.TrimSuffix(e.Name(), ".json")) {
			continue
		}
		count++
		receipt, err := j.Read(strings.TrimSuffix(e.Name(), ".json"))
		if err != nil || (receipt.Phase != "applied" && receipt.Phase != "conflict") {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		finished = append(finished, entry{e.Name(), info.ModTime()})
	}
	if count < OperationLimit {
		return nil
	}
	sort.Slice(finished, func(a, b int) bool { return finished[a].at.Before(finished[b].at) })
	for _, e := range finished {
		if count < OperationLimit {
			return nil
		}
		if err := os.Remove(filepath.Join(j.dir, e.name)); err != nil {
			return err
		}
		count--
	}
	if count >= OperationLimit {
		return fmt.Errorf("hermes-live: %d plugin operations are unfinished; inspect them before planning another", count)
	}
	return nil
}

// DiffLines is a line diff small enough for a configuration review.
func DiffLines(before, after string) string {
	oldLines, newLines := strings.Split(before, "\n"), strings.Split(after, "\n")
	var b strings.Builder
	i, j := 0, 0
	for i < len(oldLines) || j < len(newLines) {
		switch {
		case i < len(oldLines) && j < len(newLines) && oldLines[i] == newLines[j]:
			i++
			j++
		case j < len(newLines) && (i >= len(oldLines) || !containsLine(oldLines[i:], newLines[j])):
			fmt.Fprintf(&b, "  + %s\n", newLines[j])
			j++
		case i < len(oldLines):
			fmt.Fprintf(&b, "  - %s\n", oldLines[i])
			i++
		default:
			j++
		}
	}
	return b.String()
}

func containsLine(lines []string, want string) bool {
	for _, line := range lines {
		if line == want {
			return true
		}
	}
	return false
}
