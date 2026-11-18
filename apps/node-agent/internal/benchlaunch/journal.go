package benchlaunch

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinator"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchjournal"
)

const journalVersion = "agentpod.registered-launch.v1"
const maxJournal = 32 << 20

// Phases. A record only moves forward; refused and completed are terminal.
const (
	phaseReserved  = "reserved"
	phasePrepared  = "prepared"
	phaseLaunched  = "launched"
	phaseCompleted = "completed"
	phaseRefused   = "refused"
)

// step is one exchange. Request and Response hold exact private bytes, which
// can contain a lease token; the journal is a 0600 file in a 0700 directory.
type step struct {
	Name     string `json:"name"`
	Request  []byte `json:"request"`
	Sent     bool   `json:"sent"`
	Status   int    `json:"status,omitempty"`
	Response []byte `json:"response,omitempty"`
}

type record struct {
	ID        string                   `json:"id"`
	Spec      benchdispatch.SourceSpec `json:"spec"`
	Phase     string                   `json:"phase"`
	Code      string                   `json:"code,omitempty"`
	Cancelled bool                     `json:"cancelled,omitempty"`
	Release   string                   `json:"release,omitempty"` // "", "needed" or "done"
	// ReleaseFailures counts release attempts that did not free the lease. It
	// only makes an endlessly refused release visible; retries never stop.
	ReleaseFailures int                          `json:"release_failures,omitempty"`
	Steps           []step                       `json:"steps"`
	Capsule         string                       `json:"capsule_sha256,omitempty"`
	Binding         *benchdispatch.SourceBinding `json:"binding,omitempty"`
	SourceSHA       string                       `json:"source_request_sha256,omitempty"`
	Completion      *benchcoordinator.Completion `json:"completion,omitempty"`
	// BenchID is the bench generation (SuperBench's bench_id) the lease was
	// requested on, then the one it was granted on. A reclaimed key's next
	// generation has a new bench_id, so a reclaim proves this record's lease
	// gone only when it names this ID. Empty on a record written before the
	// generation was kept.
	BenchID string `json:"bench_id,omitempty"`
}

func (r *record) step(name string) *step {
	for i := range r.Steps {
		if r.Steps[i].Name == name {
			return &r.Steps[i]
		}
	}
	return nil
}
func (r *record) terminal() bool {
	return (r.Phase == phaseCompleted || r.Phase == phaseRefused) && r.Release != "needed"
}

type document struct {
	Version  string   `json:"version"`
	BenchKey string   `json:"bench_key"`
	Active   string   `json:"active,omitempty"`
	Records  []record `json:"records"`
}

// Journal is the durable per-bench record. One active attempt per bench key:
// a record that is not active can read its history but never send again.
type Journal struct{ Root string }

var errAbsent = errors.New("registered launch not reserved")

func recordID(spec benchdispatch.SourceSpec) string { return benchattempt.SourceSpecSHA256(spec) }

// update runs fn under the bench's file lock and saves when fn reports a change.
func (j Journal) update(ctx context.Context, key string, fn func(*document) (bool, error)) error {
	if benchjournal.PhysicalDir(j.Root, true) != nil || !keyName(key) {
		return benchdispatch.ErrInvalid
	}
	lockFile, err := os.OpenFile(filepath.Join(j.Root, key+".lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return benchdispatch.ErrInvalid
	}
	defer lockFile.Close()
	unlock, err := lock(ctx, lockFile)
	if err != nil {
		return err
	}
	defer unlock()
	doc := document{Version: journalVersion, BenchKey: key, Records: []record{}}
	raw, err := benchjournal.ReadFile(filepath.Join(j.Root, key+".json"), maxJournal, true)
	if err == nil {
		if benchjournal.Decode(raw, &doc) != nil || doc.Version != journalVersion || doc.BenchKey != key {
			return benchdispatch.ErrInvalid
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return benchdispatch.ErrInvalid
	}
	changed, err := fn(&doc)
	if err != nil || !changed {
		return err
	}
	out, err := json.Marshal(doc)
	if err != nil || len(out) > maxJournal {
		return benchdispatch.ErrInvalid
	}
	return benchjournal.WriteAtomic(j.Root, key+".json", out)
}

// withRecord loads the spec's own record. active reports whether it still owns
// the bench; fn decides what an inactive record may do.
func (j Journal) withRecord(ctx context.Context, spec benchdispatch.SourceSpec, fn func(r *record, active bool) (bool, error)) error {
	id := recordID(spec)
	return j.update(ctx, spec.BenchKey, func(doc *document) (bool, error) {
		for i := range doc.Records {
			if doc.Records[i].ID == id {
				r := &doc.Records[i]
				changed, err := fn(r, doc.Active == id)
				if changed && r.terminal() && doc.Active == id {
					doc.Active = ""
				}
				return changed, err
			}
		}
		return false, errAbsent
	})
}

// read returns a copy of the spec's record.
func (j Journal) read(ctx context.Context, spec benchdispatch.SourceSpec) (record, bool, error) {
	var out record
	var active bool
	err := j.withRecord(ctx, spec, func(r *record, a bool) (bool, error) {
		raw, _ := json.Marshal(r)
		active = a
		return false, json.Unmarshal(raw, &out)
	})
	return out, active, err
}

// reserve creates the record, or confirms the identical one. A different
// attempt that still owns the bench refuses with conflict.
func (j Journal) reserve(ctx context.Context, spec benchdispatch.SourceSpec) error {
	id := recordID(spec)
	return j.update(ctx, spec.BenchKey, func(doc *document) (bool, error) {
		for _, r := range doc.Records {
			if r.ID == id {
				if doc.Active != id && !r.terminal() {
					return false, refuse("stale_owner")
				}
				return false, nil
			}
		}
		if doc.Active != "" {
			return false, refuse("conflict")
		}
		if len(doc.Records) >= 256 {
			return false, benchdispatch.ErrInvalid
		}
		doc.Records = append(doc.Records, record{ID: id, Spec: spec, Phase: phaseReserved, Steps: []step{}})
		doc.Active = id
		return true, nil
	})
}

var benchKey = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$`)

func keyName(key string) bool { return benchKey.MatchString(key) }
