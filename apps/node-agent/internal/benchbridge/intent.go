package benchbridge

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchjournal"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchsource"
)

var ErrIntent = errors.New("checkpoint attempt requires retained exact intent")

const intentVersion = "agentpod.private-coordinator-intent.v1"

// Intent is PRIVATE metadata, never a response projection. In particular Spec
// paths and trusted task arguments/environment must never cross the broker.
type Intent struct {
	Version        string                    `json:"version"`
	PrepareRequest string                    `json:"prepare_request"`
	PrepareSHA256  string                    `json:"prepare_sha256"`
	Phase          string                    `json:"phase"`
	Spec           *benchdispatch.SourceSpec `json:"spec,omitempty"`
	Task           *benchdispatch.SourceTask `json:"task,omitempty"`
	ExecuteRequest string                    `json:"execute_request,omitempty"`
	ExecuteSHA256  string                    `json:"execute_sha256,omitempty"`
}

// IntentStore is independent private adapter metadata. It fixes Create and the
// resolved task BEFORE SourceCoordinator is invoked; it contains no lease token.
type IntentStore struct{ Root string }

func rawSHA(raw []byte) string { h := sha256.Sum256(raw); return hex.EncodeToString(h[:]) }
func intentName(identity benchcoordinatorwire.Identity) string {
	raw, _ := json.Marshal(identity)
	return rawSHA(raw)
}

func validIntent(i Intent, request benchcoordinatorwire.Request) bool {
	if i.Version != intentVersion || rawSHA([]byte(i.PrepareRequest)) != i.PrepareSHA256 {
		return false
	}
	stored, err := benchcoordinatorwire.ParseRequest([]byte(i.PrepareRequest))
	if err != nil || stored.Operation != "prepare" || stored.Identity == nil || request.Identity == nil ||
		*stored.Identity != *request.Identity || stored.Target == nil || request.Target == nil || *stored.Target != *request.Target {
		return false
	}
	if i.Phase == "reserved" {
		return i.Spec == nil && i.Task == nil && i.ExecuteRequest == "" && i.ExecuteSHA256 == ""
	}
	if i.Phase != "resolved" && i.Phase != "effects" || i.Spec == nil || i.Task == nil {
		return false
	}
	if i.ExecuteRequest == "" && i.ExecuteSHA256 != "" || i.ExecuteRequest != "" &&
		(i.Phase != "effects" || rawSHA([]byte(i.ExecuteRequest)) != i.ExecuteSHA256) {
		return false
	}
	if i.ExecuteRequest != "" {
		execution, err := benchcoordinatorwire.ParseRequest([]byte(i.ExecuteRequest))
		if err != nil || execution.Operation != "execute" || execution.Identity == nil || execution.Target == nil ||
			*execution.Identity != *stored.Identity || *execution.Target != *stored.Target {
			return false
		}
	}
	return benchsource.ValidSpec(*i.Spec) && i.Spec.Identity == benchdispatch.Identity(*stored.Identity) &&
		i.Spec.HostID == stored.Target.HostID && i.Spec.WorkerSHA256 == stored.Target.WorkerSHA256 &&
		len(i.Task.Arguments) > 0 && i.Task.Environment != nil &&
		i.Spec.TaskSHA256 == benchdispatch.SourceTaskSHA256(*i.Task) && stored.Task != nil &&
		i.Task.Prompt == stored.Task.Prompt && uint64(i.Task.TimeoutSeconds) == stored.Task.TimeoutSeconds &&
		i.Task.RepositoryName == stored.Task.RepositoryName
}

// withIntent holds only metadata transitions; callers never hold this lock
// while running the child. Missing/corrupt metadata never becomes fresh work.
func (s IntentStore) withIntent(ctx context.Context, request benchcoordinatorwire.Request, createRaw []byte,
	fn func(*Intent) (bool, error)) error {
	if ctx.Err() != nil || request.Identity == nil || request.Target == nil ||
		benchjournal.PhysicalDir(s.Root, true) != nil {
		return ErrIntent
	}
	base := intentName(*request.Identity)
	path := filepath.Join(s.Root, base+".lock")
	if st, err := os.Lstat(path); err == nil && (!st.Mode().IsRegular() || st.Mode().Perm() != 0600) ||
		err != nil && !errors.Is(err, os.ErrNotExist) {
		return ErrIntent
	}
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0600)
	if err != nil {
		return ErrIntent
	}
	defer f.Close()
	opened, err := f.Stat()
	st, statErr := os.Lstat(path)
	if err != nil || statErr != nil || !os.SameFile(opened, st) || !opened.Mode().IsRegular() || opened.Mode().Perm() != 0600 {
		return ErrIntent
	}
	unlock, err := intentLock(ctx, f)
	if err != nil {
		return ErrIntent
	}
	defer unlock()
	name := base + ".json"
	raw, err := benchjournal.ReadFile(filepath.Join(s.Root, name), 1<<20, true)
	var intent Intent
	if errors.Is(err, os.ErrNotExist) && len(createRaw) > 0 {
		parsed, parseErr := benchcoordinatorwire.ParseRequest(createRaw)
		if parseErr != nil || parsed.Operation != "prepare" || parsed.Identity == nil ||
			*parsed.Identity != *request.Identity || parsed.Target == nil || *parsed.Target != *request.Target {
			return ErrIntent
		}
		intent = Intent{Version: intentVersion, PrepareRequest: string(createRaw),
			PrepareSHA256: rawSHA(createRaw), Phase: "reserved"}
		initial, _ := json.Marshal(intent)
		if benchjournal.WriteAtomic(s.Root, name, initial) != nil {
			return ErrIntent
		}
	} else if err != nil || benchjournal.Decode(raw, &intent) != nil {
		return ErrIntent
	}
	if !validIntent(intent, request) || len(createRaw) > 0 && intent.PrepareSHA256 != rawSHA(createRaw) {
		return ErrIntent
	}
	changed, err := fn(&intent)
	if err != nil {
		return err
	}
	if !changed {
		return nil
	}
	if !validIntent(intent, request) {
		return ErrIntent
	}
	raw, err = json.Marshal(intent)
	var roundTrip Intent
	if err != nil || len(raw) > 1<<20 || benchjournal.Decode(raw, &roundTrip) != nil || !validIntent(roundTrip, request) || benchjournal.WriteAtomic(s.Root, name, raw) != nil {
		return ErrIntent
	}
	return nil
}

// Resolve can choose only while the durable phase proves SourceCoordinator has
// never been invoked. The chooser must perform only current-gated read-only
// status and trusted profile resolution. An existing exact choice is returned.
func (s IntentStore) Resolve(ctx context.Context, prepareRaw []byte,
	choose func(context.Context) (benchdispatch.SourceSpec, benchdispatch.SourceTask, error)) (Intent, error) {
	request, err := benchcoordinatorwire.ParseRequest(prepareRaw)
	var result Intent
	if err != nil || request.Operation != "prepare" || choose == nil {
		return result, ErrIntent
	}
	err = s.withIntent(ctx, request, prepareRaw, func(i *Intent) (bool, error) {
		if i.Phase != "reserved" {
			result = *i
			return false, nil
		}
		spec, task, err := choose(ctx)
		if err != nil || ctx.Err() != nil {
			return false, ErrIntent
		}
		i.Spec, i.Task, i.Phase = &spec, &task, "resolved"
		result = *i
		return true, nil
	})
	if err != nil {
		return Intent{}, err
	}
	return result, nil
}

// ClaimEffects is an at-most-once handoff, durably recorded before any source
// effect. An interrupted/lost handoff remains effects and never returns true again.
func (s IntentStore) ClaimEffects(ctx context.Context, prepareRaw []byte) (bool, error) {
	r, err := benchcoordinatorwire.ParseRequest(prepareRaw)
	if err != nil || r.Operation != "prepare" {
		return false, ErrIntent
	}
	claimed := false
	err = s.withIntent(ctx, r, nil, func(i *Intent) (bool, error) {
		if i.PrepareSHA256 != rawSHA(prepareRaw) || i.Phase == "reserved" {
			return false, ErrIntent
		}
		if i.Phase == "effects" {
			return false, nil
		}
		i.Phase, claimed = "effects", true
		return true, nil
	})
	return claimed && err == nil, err
}

// Read performs no source discovery, creation decision, lease operation or launch.
func (s IntentStore) Read(ctx context.Context, request benchcoordinatorwire.Request) (Intent, error) {
	var result Intent
	err := s.withIntent(ctx, request, nil, func(i *Intent) (bool, error) { result = *i; return false, nil })
	if err != nil {
		return Intent{}, ErrIntent
	}
	return result, nil
}

// ClaimExecution retains the exact source receipt/body before an at-most-once
// launch handoff. It does not validate admission: the concrete Manager must
// independently obtain fresh Hub current/admission decisions before execution.
func (s IntentStore) ClaimExecution(ctx context.Context, executeRaw []byte) (bool, error) {
	r, err := benchcoordinatorwire.ParseRequest(executeRaw)
	if err != nil || r.Operation != "execute" {
		return false, ErrIntent
	}
	claimed := false
	err = s.withIntent(ctx, r, nil, func(i *Intent) (bool, error) {
		if i.Phase != "effects" {
			return false, ErrIntent
		}
		if i.ExecuteRequest != "" {
			if i.ExecuteSHA256 != rawSHA(executeRaw) {
				return false, ErrIntent
			}
			return false, nil
		}
		i.ExecuteRequest, i.ExecuteSHA256 = string(executeRaw), rawSHA(executeRaw)
		claimed = true
		return true, nil
	})
	return claimed && err == nil, err
}
