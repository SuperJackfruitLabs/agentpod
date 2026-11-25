package benchremote

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchattempt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinator"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchcoordinatorwire"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchlaunch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

func testSpec() (benchdispatch.SourceSpec, benchdispatch.SourceTask, []benchworkspace.Repository) {
	id := benchattempt.Identity{TenantID: "tenant", BoardID: "brd_board1", CardID: "card_card01", StageID: "write", RunID: "run_run001", Epoch: 1, AgentID: "agt_agent1", StationID: "station", NodeID: "node", AttemptID: "attempt-1", ControlPrincipalID: "prn_principal", ControlGrantID: "control-grant", PolicySHA256: digest([]byte("policy"))}
	task := benchdispatch.SourceTask{Prompt: "do the card", Environment: map[string]string{}, TimeoutSeconds: 60, RepositoryName: "a"}
	spec := benchdispatch.SourceSpec{Identity: id, HostID: "host", BenchKey: "cp_test", Holder: "cp_holder", ContextParent: "/private-context", DataRoot: "/data", CheckpointRepository: "a", WorkerPath: "/opt/agentpod-bench-worker", WorkerSHA256: digest([]byte("worker")), TaskSHA256: benchdispatch.SourceTaskSHA256(task), LeaseRequestID: "lease_x", RunRequestID: "run_x"}
	var repos []benchworkspace.Repository
	for _, name := range []string{"a", "b"} {
		url := "/authorized/" + name
		spec.Repositories = append(spec.Repositories, benchdispatch.SourceRepository{Name: name, RepositorySHA256: digest([]byte(url)), TaskRef: "refs/heads/card/" + id.CardID, Base: "main", ObjectFormat: "sha1"})
		repos = append(repos, benchworkspace.Repository{Name: name, Repository: url, Branch: "card/" + id.CardID, Base: "main"})
	}
	return spec, task, repos
}

// testKey is an ed25519 public key line whose key bytes are seed.
func testKey(seed byte) string {
	// Each part is length-prefixed (big-endian uint32): the type (11 bytes), then the key (32).
	var blob bytes.Buffer
	blob.Write([]byte{0, 0, 0, 11})
	blob.WriteString("ssh-ed25519")
	blob.Write([]byte{0, 0, 0, 32})
	blob.Write(bytes.Repeat([]byte{seed}, 32))
	return "ssh-ed25519 " + base64.StdEncoding.EncodeToString(blob.Bytes()) + " agent@workspace"
}

type trial struct {
	*fakeBenchd
	c          Coordinator
	spec       benchdispatch.SourceSpec
	task       benchdispatch.SourceTask
	root       string
	superseded atomic.Bool
}

func newTrial(t *testing.T) *trial {
	spec, task, repos := testSpec()
	base, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	root := JournalRoot(base)
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	f, client := newFakeBenchd(t, spec.BenchKey)
	tr := &trial{fakeBenchd: f, spec: spec, task: task, root: root}
	tr.c = Coordinator{Journal: Journal{Root: root}, Producer: client, Client: client, Repositories: repos, Current: func(context.Context, benchdispatch.SourceSpec) error {
		if tr.superseded.Load() {
			return benchlaunch.ErrSuperseded
		}
		return nil
	}}
	return tr
}

func wantCode(t *testing.T, err error, code string) {
	t.Helper()
	if got, ok := benchlaunch.RefusalCode(err); !ok || got != code {
		t.Fatalf("want refusal %s, got %v", code, err)
	}
}

func (tr *trial) prepare(t *testing.T) string {
	t.Helper()
	p, err := tr.c.Prepare(context.Background(), tr.spec, tr.task)
	if err != nil {
		t.Fatal("prepare", err)
	}
	return p.BindingSHA256
}

func (tr *trial) attach(t *testing.T, binding, key string) benchworkspace.RemoteCredential {
	t.Helper()
	c, err := tr.c.Attach(context.Background(), tr.spec, binding, key)
	if err != nil {
		t.Fatal("attach", err)
	}
	return c
}

var report = Report{Handoff: map[string]string{"summary": "done <&> 界", "url": "https://example.test/pr/1"}, Outcome: "complete"}

// journal reads the bench's journal document and this record's remote state.
func (tr *trial) journal(t *testing.T) ([]byte, map[string]any, state) {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join(tr.root, tr.spec.BenchKey+".json"))
	if err != nil {
		t.Fatal(err)
	}
	var doc map[string]any
	if err := json.Unmarshal(raw, &doc); err != nil {
		t.Fatal(err)
	}
	records := doc["records"].([]any)
	record := records[len(records)-1].(map[string]any)
	var s state
	if remote, ok := record["remote"]; ok {
		encoded, _ := json.Marshal(remote)
		if s, err = decodeState(encoded); err != nil {
			t.Fatal(err)
		}
	}
	return raw, record, s
}

func TestPrepareTakesLeaseWithoutRegistration(t *testing.T) {
	tr := newTrial(t)
	p, err := tr.c.Prepare(context.Background(), tr.spec, tr.task)
	if err != nil {
		t.Fatal(err)
	}
	b := p.Binding
	if len(b.Operations) != 2 || b.Operations[0].Step != "lease" || b.Operations[1].Step != "checkpoint" || b.Members[0].Commit != fakeCommitA || p.SourceRequestSHA256 == "" || b.ContextSHA256 == "" {
		t.Fatal("binding incomplete", b.Operations)
	}
	if got := tr.sequence(0); !reflect.DeepEqual(got, []string{"status", "lease", "checkpoint"}) {
		t.Fatal("prepare is a status read, a lease and a checkpoint, and nothing else", got)
	}
	if !tr.leased {
		t.Fatal("lease not held after prepare")
	}
	// A repeated prepare replays the journal; nothing is sent again.
	again, err := tr.c.Prepare(context.Background(), tr.spec, tr.task)
	if err != nil || again.BindingSHA256 != p.BindingSHA256 || tr.count("lease") != 1 || tr.count("checkpoint") != 1 {
		t.Fatal("prepare did not resume from its journal", err)
	}
	raw, _, _ := tr.journal(t)
	if !bytes.Contains(raw, []byte(`"version":"`+JournalVersion+`"`)) {
		t.Fatal("journal is not the remote launch's")
	}
	for path, mode := range map[string]os.FileMode{tr.root: 0700, filepath.Join(tr.root, tr.spec.BenchKey+".json"): 0600} {
		if st, err := os.Stat(path); err != nil || st.Mode().Perm() != mode {
			t.Fatalf("%s mode %v, want %v", path, st.Mode().Perm(), mode)
		}
	}
	status, err := tr.c.Status(context.Background(), tr.spec)
	if err != nil || status.State != "prepared" {
		t.Fatal("prepared record not reported prepared", status.State, err)
	}
}

func TestAttachReturnsCredentialAndJournalsNoToken(t *testing.T) {
	tr := newTrial(t)
	binding := tr.prepare(t)
	key := testKey(1)
	before := tr.count("credential")
	cred := tr.attach(t, binding, key)
	if cred.User != "b-11111111111111111111111111111111" || cred.WorkingDirectory != "/bounded/benches/card-1" || cred.HostKeyFingerprint == "" || !strings.HasPrefix(cred.Certificate, "ssh-ed25519-cert-v01@openssh.com ") {
		t.Fatal("credential incomplete", cred)
	}
	if tr.count("credential") != before+1 || tr.keys[len(tr.keys)-1] != key {
		t.Fatal("benchd was not asked to sign the agent's key")
	}
	// The reply bytes carry the certificate and never the token.
	out, _ := json.Marshal(cred)
	if bytes.Contains(out, []byte(fakeToken)) {
		t.Fatal("credential carries the lease token")
	}
	// The journal holds the token in its step bytes only, as the registered
	// launch does; the remote state beside them holds no token or certificate.
	raw, record, s := tr.journal(t)
	if bytes.Contains(raw, []byte(fakeToken)) {
		t.Fatal("token outside step bytes")
	}
	found := false
	for _, step := range record["steps"].([]any) {
		for _, field := range []string{"request", "response"} {
			encoded, _ := step.(map[string]any)[field].(string)
			decoded, _ := base64.StdEncoding.DecodeString(encoded)
			found = found || bytes.Contains(decoded, []byte(fakeToken))
		}
	}
	if !found {
		t.Fatal("token not kept in the lease step")
	}
	delete(record, "steps")
	rest, _ := json.Marshal(record)
	for _, secret := range []string{fakeToken, base64.StdEncoding.EncodeToString([]byte(fakeToken)), cred.Certificate, strings.Fields(key)[1]} {
		if bytes.Contains(rest, []byte(secret)) {
			t.Fatal("remote state holds a token, certificate or key")
		}
	}
	want, _ := Fingerprint(key)
	if s.Fingerprint != want || !hex32.MatchString(s.ExecutionID) {
		t.Fatal("fingerprint or execution not journaled", s)
	}
}

func TestAttachRenewsWithSameKey(t *testing.T) {
	tr := newTrial(t)
	binding := tr.prepare(t)
	key := testKey(1)
	tr.attach(t, binding, key)
	_, _, first := tr.journal(t)
	tr.attach(t, binding, key)
	_, _, second := tr.journal(t)
	if tr.count("credential") != 2 || tr.keys[0] != key || tr.keys[1] != key {
		t.Fatal("renewal did not ask benchd again with the same key")
	}
	if !reflect.DeepEqual(first, second) {
		t.Fatal("renewal changed the journaled key or execution", first, second)
	}
}

func TestAttachDifferentKeyRefused(t *testing.T) {
	tr := newTrial(t)
	binding := tr.prepare(t)
	tr.attach(t, binding, testKey(1))
	_, err := tr.c.Attach(context.Background(), tr.spec, binding, testKey(2))
	wantCode(t, err, "conflict")
	if tr.count("credential") != 1 {
		t.Fatal("a second key reached benchd")
	}
	_, err = tr.c.Attach(context.Background(), tr.spec, strings.Repeat("f", 64), testKey(1))
	wantCode(t, err, "conflict") // another binding
	_, err = tr.c.Attach(context.Background(), tr.spec, binding, "not a key")
	wantCode(t, err, "invalid")
}

func TestAttachAfterBenchdRestartRecordsNewExecution(t *testing.T) {
	tr := newTrial(t)
	binding := tr.prepare(t)
	key := testKey(1)
	tr.attach(t, binding, key)
	_, _, before := tr.journal(t)
	tr.restart()
	tr.attach(t, binding, key)
	_, _, after := tr.journal(t)
	if after.ExecutionID == before.ExecutionID || !hex32.MatchString(after.ExecutionID) || after.Fingerprint != before.Fingerprint {
		t.Fatal("new execution not journaled", before, after)
	}
	completion, err := tr.c.Finish(context.Background(), tr.spec, binding, report)
	if err != nil || completion.Service.ExecutionID != after.ExecutionID {
		t.Fatal("completion does not name the latest execution", err)
	}
}

func TestAttachAfterFinishRefused(t *testing.T) {
	tr := newTrial(t)
	binding := tr.prepare(t)
	key := testKey(1)
	tr.attach(t, binding, key)
	if _, err := tr.c.Finish(context.Background(), tr.spec, binding, report); err != nil {
		t.Fatal(err)
	}
	issued := tr.count("credential")
	_, err := tr.c.Attach(context.Background(), tr.spec, binding, key)
	wantCode(t, err, "conflict")
	if tr.count("credential") != issued {
		t.Fatal("a certificate was asked for after finish")
	}
}

func TestFinishCompletesWithRemoteExecutionAndReportDigest(t *testing.T) {
	tr := newTrial(t)
	binding := tr.prepare(t)
	tr.attach(t, binding, testKey(1))
	_, _, attached := tr.journal(t)
	n := len(tr.sequence(0))
	completion, err := tr.c.Finish(context.Background(), tr.spec, binding, report)
	if err != nil {
		t.Fatal(err)
	}
	if got := tr.sequence(n); !reflect.DeepEqual(got, []string{"checkpoint", "stop", "release"}) {
		t.Fatal("finish is a checkpoint, a stop and a release, in that order", got)
	}
	if tr.leased {
		t.Fatal("lease still held after finish")
	}
	_, _, s := tr.journal(t)
	canonical, _ := report.Canonical()
	svc := completion.Service
	if !bytes.Equal(s.Report, canonical) || svc.WorkerResultSHA256 != digest(s.Report) {
		t.Fatal("worker result digest is not the journaled report's")
	}
	if !regexp.MustCompile(`^[a-f0-9]{32}$`).MatchString(svc.ExecutionID) || svc.ExecutionID != attached.ExecutionID || !svc.Stopped || !svc.Released || svc.Kind != "grouped-v2" {
		t.Fatal("service evidence wrong", svc)
	}
	if svc.GenerationID != strings.Repeat("4", 32) || svc.Checkpoints[0].Commit != fakeCommitE || completion.Task.Outcome != "complete" || completion.Task.Handoff["summary"] != report.Handoff["summary"] {
		t.Fatal("completion does not carry the finishing checkpoint and report", svc)
	}
	// It is what the coordinator wire admits as a finish's completion.
	wireCompletion(t, tr.spec, binding, completion)
	// A repeated finish (a lost reply) answers the same completion and sends nothing.
	n = len(tr.sequence(0))
	again, err := tr.c.Finish(context.Background(), tr.spec, binding, report)
	if err != nil || !reflect.DeepEqual(again, completion) || len(tr.sequence(n)) != 0 {
		t.Fatal("finish not idempotent", err, tr.sequence(n))
	}
	status, err := tr.c.Status(context.Background(), tr.spec)
	if err != nil || status.State != "completed" || status.Completion == nil {
		t.Fatal("finished record not completed", err)
	}
}

// wireCompletion checks the completion the way the handler serves it.
func wireCompletion(t *testing.T, spec benchdispatch.SourceSpec, binding string, c benchcoordinator.Completion) {
	t.Helper()
	prepared := benchcoordinator.Prepared{Binding: c.Source, BindingSHA256: benchdispatch.SourceBindingSHA256(c.Source), RequestID: spec.RunRequestID, CheckpointRepository: spec.CheckpointRepository, SourceRequestSHA256: c.SourceRequestSHA256}
	raw, _ := json.Marshal(map[string]any{"source": prepared, "service": c.Service, "task": c.Task, "source_request_sha256": c.SourceRequestSHA256, "source_receipt_sha256": c.SourceReceiptSHA256})
	var completion benchcoordinatorwire.Completion
	if err := json.Unmarshal(raw, &completion); err != nil {
		t.Fatal(err)
	}
	identity := benchcoordinatorwire.Identity(spec.Identity)
	target := benchcoordinatorwire.Target{TenantID: identity.TenantID, BoardID: identity.BoardID, AgentID: identity.AgentID, StationID: identity.StationID, NodeID: identity.NodeID, HostID: spec.HostID,
		RegistrySHA256: digest([]byte("registry")), CoordinatorImplementationSHA256: digest([]byte("node")), ExecutionMode: "linux-cgroup-v2", BenchProtocol: benchworkspace.Version, WorkerVersion: "agentpod.superbench-worker.v2", WorkerSHA256: spec.WorkerSHA256}
	request := benchcoordinatorwire.Request{Version: benchcoordinatorwire.Version, Operation: "finish", TenantID: identity.TenantID, BoardID: identity.BoardID, StationID: identity.StationID,
		Identity: &identity, Target: &target, BindingSHA256: binding, Report: &benchcoordinatorwire.Report{Handoff: report.Handoff, Outcome: report.Outcome}}
	response := benchcoordinatorwire.Response{Version: benchcoordinatorwire.Version, Operation: "finish", State: "completed", Identity: &identity, Target: &target, Completion: &completion}
	out, _ := json.Marshal(response)
	if _, err := benchcoordinatorwire.ParseResponse(out, request); err != nil {
		t.Fatal("the wire refuses the remote completion", err)
	}
}

func TestFinishDirtyTreeRefusesAndKeepsLease(t *testing.T) {
	tr := newTrial(t)
	binding := tr.prepare(t)
	key := testKey(1)
	tr.attach(t, binding, key)
	tr.dirty = true
	n := len(tr.sequence(0))
	_, err := tr.c.Finish(context.Background(), tr.spec, binding, report)
	wantCode(t, err, "dirty")
	if !strings.HasPrefix(benchlaunch.RefusalMessage(err), "workspace has uncommitted or untracked files") || !strings.Contains(benchlaunch.RefusalMessage(err), "a/notes.txt") || benchlaunch.RefusalLeaseHeld(err) {
		t.Fatal("dirty refusal does not say why", benchlaunch.RefusalMessage(err))
	}
	if got := tr.sequence(n); !reflect.DeepEqual(got, []string{"checkpoint"}) || !tr.leased {
		t.Fatal("a dirty finish stopped or released the lease", got)
	}
	// The record is still live: the agent attaches again (benchd fenced the
	// old execution), commits, and finishes.
	status, err := tr.c.Status(context.Background(), tr.spec)
	if err != nil || status.State != "prepared" {
		t.Fatal("dirty record not still prepared", status.State, err)
	}
	tr.attach(t, binding, key)
	_, _, s := tr.journal(t)
	tr.dirty = false
	completion, err := tr.c.Finish(context.Background(), tr.spec, binding, report)
	if err != nil || tr.leased || completion.Service.ExecutionID != s.ExecutionID {
		t.Fatal("finish after a dirty tree did not complete", err)
	}
}

func TestCancelStopsAndReleases(t *testing.T) {
	tr := newTrial(t)
	binding := tr.prepare(t)
	key := testKey(1)
	tr.attach(t, binding, key)
	n := len(tr.sequence(0))
	tr.superseded.Store(true)
	if _, err := tr.c.Cancel(context.Background(), tr.spec); err != nil {
		wantCode(t, err, "stale_owner")
	}
	if got := tr.sequence(n); !reflect.DeepEqual(got, []string{"stop", "release"}) || tr.leased {
		t.Fatal("cancel is a stop, then a release", got)
	}
	tr.superseded.Store(false)
	_, err := tr.c.Attach(context.Background(), tr.spec, binding, key)
	wantCode(t, err, "conflict")
	_, err = tr.c.Finish(context.Background(), tr.spec, binding, report)
	wantCode(t, err, "stale_owner") // the record's own end
	if tr.count("credential") != 1 {
		t.Fatal("a certificate was asked for after cancel")
	}
}

func TestExecuteUnsupportedForRemoteProfile(t *testing.T) {
	tr := newTrial(t)
	tr.prepare(t)
	n := len(tr.sequence(0))
	_, err := tr.c.Execute(context.Background(), tr.spec, func(context.Context, benchdispatch.SourceBinding) error { return nil })
	wantCode(t, err, "unsupported")
	if len(tr.sequence(n)) != 0 {
		t.Fatal("execute reached benchd")
	}
}
