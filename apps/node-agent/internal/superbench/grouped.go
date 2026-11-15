package superbench

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// GroupedWorkerVersion is private, unwired producer groundwork, not accepted
// checkpoint certification. The scalar worker protocol and invocation stay v1.
const GroupedWorkerVersion = "agentpod.superbench-worker.v2"

var groupedName = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]{0,63}$`)
var groupedDigest = regexp.MustCompile(`^[a-f0-9]{64}$`)
var groupedBenchID = regexp.MustCompile(`^[a-f0-9]{32}$`)
var groupedID = regexp.MustCompile(`^(brd|card|run)_[A-Za-z0-9]{6,}$`)
var errGrouped = errors.New("protected grouped worker admission refused")

type GroupedMember struct {
	Name             string `json:"name"`
	RepositorySHA256 string `json:"repository_sha256"`
	TaskRef          string `json:"task_ref"`
	ObjectFormat     string `json:"object_format"`
	Commit           string `json:"commit"`
}

// WorkspaceRoot is the authorized service root; repository paths are derived
// from it and logical names. ContextSHA is an immutable service-run argument,
// not a field that an editable context could use to approve its own contents.
type GroupedWorkerSpec struct {
	Version        string            `json:"version"`
	Binding        Binding           `json:"binding"`
	BenchKey       string            `json:"bench_key"`
	BenchID        string            `json:"bench_id"`
	WorkspaceRoot  string            `json:"workspace_root"`
	RepositoryName string            `json:"repository_name,omitempty"`
	Members        []GroupedMember   `json:"members"`
	Arguments      []string          `json:"arguments"`
	Prompt         string            `json:"prompt"`
	Environment    map[string]string `json:"environment"`
	TimeoutSeconds uint32            `json:"timeout_seconds"`
}

func ValidGroupedContextDigest(value string) bool { return groupedDigest.MatchString(value) }
func groupedSHA(raw []byte) string                { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }
func below(parent, path string) bool {
	rel, e := filepath.Rel(parent, path)
	return e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) && !filepath.IsAbs(rel)
}
func physicalGroupedDir(path string) error {
	if !filepath.IsAbs(path) || filepath.Clean(path) != path || len(path) > 4096 {
		return errGrouped
	}
	s, e := os.Lstat(path)
	if e != nil || !s.IsDir() || s.Mode()&os.ModeSymlink != 0 {
		return errGrouped
	}
	actual, e := filepath.EvalSymlinks(path)
	if e != nil || actual != path {
		return errGrouped
	}
	return nil
}
func validateGrouped(s GroupedWorkerSpec) error {
	if s.Version != GroupedWorkerVersion || !keyPattern.MatchString(s.BenchKey) || !groupedBenchID.MatchString(s.BenchID) || !s.Binding.valid() || s.Binding.Epoch > 1<<53-1 {
		return errGrouped
	}
	for i, id := range []string{s.Binding.BoardID, s.Binding.CardID, s.Binding.RunID} {
		prefix := []string{"brd_", "card_", "run_"}[i]
		if !groupedID.MatchString(id) || !strings.HasPrefix(id, prefix) {
			return errGrouped
		}
	}
	if !filepath.IsAbs(s.WorkspaceRoot) || filepath.Clean(s.WorkspaceRoot) != s.WorkspaceRoot || len(s.WorkspaceRoot) > 4096 || filepath.Base(s.WorkspaceRoot) != s.BenchKey || filepath.Base(filepath.Dir(s.WorkspaceRoot)) != "benches" || len(s.Members) < 1 || len(s.Members) > 32 || s.Environment == nil {
		return errGrouped
	}
	if e := validateSpec(WorkerSpec{Version: WorkerVersion, Binding: s.Binding, Directory: s.WorkspaceRoot, Arguments: s.Arguments, Environment: s.Environment, TimeoutSeconds: s.TimeoutSeconds}); e != nil {
		return errGrouped
	}
	selected := s.RepositoryName == ""
	repos := map[string]bool{}
	for i, m := range s.Members {
		if !groupedName.MatchString(m.Name) || i > 0 && s.Members[i-1].Name >= m.Name || !groupedDigest.MatchString(m.RepositorySHA256) || repos[m.RepositorySHA256] || m.TaskRef != "refs/heads/card/"+s.Binding.CardID || !commitPattern.MatchString(m.Commit) || m.ObjectFormat != "sha1" && m.ObjectFormat != "sha256" || m.ObjectFormat == "sha1" && len(m.Commit) != 40 || m.ObjectFormat == "sha256" && len(m.Commit) != 64 {
			return errGrouped
		}
		repos[m.RepositorySHA256] = true
		selected = selected || s.RepositoryName == m.Name
	}
	if !selected {
		return errGrouped
	}
	return nil
}
func noGroupedNull(value any) bool {
	switch v := value.(type) {
	case nil:
		return false
	case []any:
		for _, x := range v {
			if !noGroupedNull(x) {
				return false
			}
		}
	case map[string]any:
		for _, x := range v {
			if !noGroupedNull(x) {
				return false
			}
		}
	}
	return true
}
func decodeGrouped(raw []byte, s *GroupedWorkerSpec) error {
	if strictWorkerJSON(raw, s) != nil {
		return errGrouped
	}
	var value any
	if json.Unmarshal(raw, &value) != nil || !noGroupedNull(value) || validateGrouped(*s) != nil {
		return errGrouped
	}
	return nil
}

// PrepareGroupedWorker durably packages data only. It neither acquires a lease
// nor launches a process. The caller binds the returned digest in benchd.run's
// third argv element and records it in its immutable source admission.
func PrepareGroupedWorker(parent string, s GroupedWorkerSpec) (string, string, error) {
	if validateGrouped(s) != nil || physicalGroupedDir(parent) != nil || below(s.WorkspaceRoot, parent) {
		return "", "", errGrouped
	}
	info, e := os.Lstat(parent)
	if e != nil || info.Mode().Perm() != 0700 {
		return "", "", errGrouped
	}
	raw, e := json.Marshal(s)
	if e != nil || len(raw) > MaxWorker {
		return "", "", errGrouped
	}
	dir, e := os.MkdirTemp(parent, "superbench-grouped-")
	if e != nil {
		return "", "", errGrouped
	}
	if writePrivate(filepath.Join(dir, "request.json"), raw) != nil || syncDirectory(dir) != nil || syncDirectory(parent) != nil {
		return "", "", errGrouped
	}
	return dir, groupedSHA(raw), nil
}

// ExecuteGroupedWorker is invoked BY benchd.run with repository_name omitted.
// Its check happens after service preparation, inside the fenced payload. A
// successful service run of this pinned wrapper is not cryptographic attestation
// and cannot isolate malicious concurrent commands running under the same UID.
func ExecuteGroupedWorker(ctx context.Context, dir, expectedSHA string) error {
	if !ValidGroupedContextDigest(expectedSHA) || physicalGroupedDir(dir) != nil {
		return errGrouped
	}
	info, e := os.Lstat(dir)
	if e != nil || info.Mode().Perm() != 0700 {
		return errGrouped
	}
	request := filepath.Join(dir, "request.json")
	info, e = os.Lstat(request)
	if e != nil || info.Mode().Perm() != 0600 {
		return errGrouped
	}
	raw, e := groupedRegular(request, MaxWorker)
	if e != nil || groupedSHA(raw) != expectedSHA {
		return errGrouped
	}
	var s GroupedWorkerSpec
	if decodeGrouped(raw, &s) != nil || below(s.WorkspaceRoot, dir) {
		return errGrouped
	}
	cwd, e := os.Getwd()
	if e != nil || cwd != s.WorkspaceRoot || physicalGroupedDir(cwd) != nil {
		return errGrouped
	}
	// An invalid hash or context causes no marker/home/result writes. Once the
	// exact context is authorized, consume its one execution opportunity durably.
	f, e := os.OpenFile(filepath.Join(dir, "started"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if e != nil {
		return errGrouped
	}
	syncErr := f.Sync()
	closeErr := f.Close()
	if syncErr != nil || closeErr != nil || syncDirectory(dir) != nil {
		return errGrouped
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(s.TimeoutSeconds)*time.Second)
	defer cancel()
	preflight, cancelPreflight := context.WithTimeout(ctx, 30*time.Second)
	e = inspectGrouped(preflight, dir, s)
	cancelPreflight()
	if e != nil {
		return errGrouped
	}
	for _, name := range []string{"home", "tmp"} {
		if os.Mkdir(filepath.Join(dir, name), 0700) != nil {
			return errGrouped
		}
	}
	selected := s.WorkspaceRoot
	if s.RepositoryName != "" {
		selected = filepath.Join(selected, s.RepositoryName)
	}
	cmd := exec.CommandContext(ctx, s.Arguments[0], s.Arguments[1:]...)
	cmd.Dir = selected
	cmd.Env = childEnvironment(WorkerSpec{Environment: s.Environment}, dir)
	cmd.WaitDelay = 2 * time.Second
	prompt, _ := json.Marshal(struct {
		Binding Binding `json:"binding"`
		Prompt  string  `json:"prompt"`
	}{s.Binding, s.Prompt})
	cmd.Stdin = bytes.NewReader(prompt)
	capture := &boundedBuffer{}
	cmd.Stdout = capture
	// No ambient service credentials or stderr reach the structured result.
	if cmd.Run() != nil {
		return errGrouped
	}
	resultRaw, overflow := capture.read()
	if overflow {
		return errGrouped
	}
	var r WorkerResult
	if decodeGroupedResult(resultRaw, &r, s.Binding) != nil {
		return errGrouped
	}
	if writePrivate(filepath.Join(dir, "result.json"), resultRaw) != nil || syncDirectory(dir) != nil {
		return errGrouped
	}
	return nil
}
func decodeGroupedResult(raw []byte, r *WorkerResult, b Binding) error {
	var value any
	if strictWorkerJSON(raw, r) != nil || json.Unmarshal(raw, &value) != nil || !noGroupedNull(value) || !validGroupedResult(*r, b) {
		return errGrouped
	}
	return nil
}

func validGroupedResult(r WorkerResult, b Binding) bool {
	return r.Version == GroupedWorkerVersion && r.Binding == b && r.Handoff != nil && (r.Outcome == "complete" || r.Outcome == "blocked" || r.Outcome == "failed")
}

// ReadGroupedWorkerResult reads task output only, never fence/checkpoint/release proof.
func ReadGroupedWorkerResult(dir string, b Binding) (WorkerResult, error) {
	var r WorkerResult
	raw, e := readPrivate(filepath.Join(dir, "result.json"))
	if e != nil || decodeGroupedResult(raw, &r, b) != nil {
		return r, errGrouped
	}
	return r, nil
}
