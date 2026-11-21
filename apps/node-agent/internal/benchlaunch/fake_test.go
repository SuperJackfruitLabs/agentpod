package benchlaunch

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

// fakeBench is a scripted SuperBench producer speaking the real wire bytes.
// It keeps exact receipts so a repeated request ID replays instead of acting.
type fakeBench struct {
	mu               sync.Mutex
	t                *testing.T
	benchID          string
	holder           string
	token            string
	leased           bool
	posts            map[string]int // every request that reached the producer, by operation
	effects          map[string]int // operations that actually acted
	receipts         map[string]receipt
	loseAfter        map[string]bool // act, keep the receipt, drop the reply
	loseBefore       map[string]bool // drop the request before it acts
	inProgress       map[string]bool // answer in_progress once, keep acting in the background
	capacity         map[string]bool
	exit             int
	stdout           func(frame []byte) []byte
	lookup           string // forced lookup state, e.g. "absent"
	tamperRead       bool
	block            chan struct{} // run waits here until closed or ctx ends
	running          chan struct{} // closed when a blocked run has started
	refuseRelease    int           // answer this many releases with conflict while still leased
	malformedRelease int           // answer this many releases with an unparseable 500
	cancels          []benchworkspace.CancelRequest
	lastCapsule      superbench.RegisteredCapsule
	runArgs          []string
	reclaim          string // "", "reclaiming" or "reclaimed": SuperBench reclaimed the bench by itself
	afterStatus      func() // runs under the lock once a status reply is built
	// A create that never finished: the workspace stays in this phase
	// ("initializing" or "materializing") under its initialization owner.
	stuck        string
	initToken    string // the initialization owner's token
	stopped      bool   // the initialization owner was stopped
	failCreate   bool   // the next create fails and leaves the bench stuck with a grant
	holdRecreate bool   // the host has not freed the stuck tree: a create stays a conflict
	sameRecreate bool   // a create over a stuck bench reports the old bench_id (a producer fault)
	// absent: the key has no bench yet. A specific-key status answers the
	// contract's not_found (never an empty inventory) and a create makes it.
	absent bool
	// statusDown: status answers the contract's unavailable.
	statusDown bool
	// killed: the run's payload is killed by a benchd restart. benchd stores
	// this exact reply as the run's completed receipt and keeps the stopped
	// lease; killedLive also delivers it, otherwise the reply is lost.
	killed     []byte
	killedLive bool
	// barrier: the run is cancelled mid-flight. benchd answers its POST with
	// barrierReply (or loses it), stores no receipt for it (receipt_save_failed
	// "operation cancellation requested"), and its lookup answers in_progress
	// until a cancel arrives, then cancel_requested for ever. The lease stays
	// held by this holder; once cancelled it shows stop_requested, with its
	// execution running for stopLag more status reads, then stopped.
	barrier          bool
	barrierReply     []byte
	barrierCancelled bool
	stopLag          int
}
type receipt struct {
	digest string
	status int
	body   []byte
}

const fakeCommitA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const fakeCommitB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

func newFake(t *testing.T) *fakeBench {
	return &fakeBench{t: t, benchID: strings.Repeat("1", 32), posts: map[string]int{}, effects: map[string]int{}, receipts: map[string]receipt{}, loseAfter: map[string]bool{}, loseBefore: map[string]bool{}, inProgress: map[string]bool{}, capacity: map[string]bool{}}
}

func (f *fakeBench) count(m map[string]int, op string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return m[op]
}

func (f *fakeBench) workspace(spec benchdispatch.SourceSpec, held bool, generation string, commits ...string) benchworkspace.Workspace {
	w := benchworkspace.Workspace{Key: spec.BenchKey, BenchID: f.benchID, Phase: "ready", MemberCount: 2, CheckpointRepository: "a", ReadyForAcquisition: !held, QuotaBytes: 1 << 30, QuotaInodes: 1 << 20,
		Checkpoint: &benchworkspace.Checkpoint{GenerationID: generation, ManifestSHA256: strings.Repeat("c", 64), Members: []benchworkspace.Commit{{Name: "a", Commit: commits[0]}, {Name: "b", Commit: commits[1]}}, Seal: commits[0]}}
	if held {
		w.Lease = &benchworkspace.LeaseSummary{Holder: f.holder, Mode: "cooperative"}
	}
	return w
}

// stuckWorkspace is a create that never finished, held by its initialization owner.
func (f *fakeBench) stuckWorkspace(spec benchdispatch.SourceSpec) benchworkspace.Workspace {
	return benchworkspace.Workspace{Key: spec.BenchKey, BenchID: f.benchID, Phase: f.stuck, MemberCount: 2, CheckpointRepository: "a", QuotaBytes: 1 << 30, QuotaInodes: 1 << 20,
		Lease: &benchworkspace.LeaseSummary{Holder: "initialization", Mode: "supervised", StopRequested: f.stopped, Execution: &benchworkspace.Execution{ID: strings.Repeat("3", 32), Phase: "stopped"}}}
}

func envelope(op, requestID string, ok bool, result any, code string) []byte {
	m := map[string]any{"version": benchworkspace.Version, "operation": op, "ok": ok}
	if requestID != "" {
		m["request_id"] = requestID
	}
	if result != nil {
		m["result"] = result
	}
	if code != "" {
		m["error"] = map[string]string{"code": code, "message": "refused"}
	}
	raw, _ := json.Marshal(m)
	return raw
}

func (f *fakeBench) Post(ctx context.Context, path, contentType string, raw []byte, limit int) (int, []byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	spec, _, _ := testSpec()
	switch path {
	case benchworkspace.PathRegistration:
		f.posts["observe"]++
		var r benchworkspace.RegistrationObserveRequest
		_ = json.Unmarshal(raw, &r)
		if !f.leased || r.LeaseToken != f.token || r.Holder != f.holder {
			return 409, []byte(`{"version":"superbench.v2","operation":"registration_observe","ok":false,"error":{"code":"conflict","message":"refused"}}`), nil
		}
		n := func(i int) benchworkspace.RegistrationNode {
			return benchworkspace.RegistrationNode{Device: "7", Inode: strconv.Itoa(i)}
		}
		o := benchworkspace.RegistrationObservation{Key: spec.BenchKey, BenchID: f.benchID, RootPath: "/data/benches/" + spec.BenchKey, LayoutVersion: benchworkspace.LayoutVersion, PolicySHA256: strings.Repeat("d", 64), Root: n(1), RootHome: n(2), RootTemp: n(3),
			Members:    []benchworkspace.RegistrationMember{{Name: "a", Checkout: n(4), Admin: n(5), Home: n(6), Temp: n(7)}, {Name: "b", Checkout: n(8), Admin: n(9), Home: n(10), Temp: n(11)}},
			Checkpoint: benchworkspace.RegistrationCheckpoint{GenerationID: strings.Repeat("2", 32), Seal: fakeCommitA, ManifestSHA256: strings.Repeat("c", 64), Members: []benchworkspace.Commit{{Name: "a", Commit: fakeCommitA}, {Name: "b", Commit: fakeCommitB}}}}
		body, _ := json.Marshal(benchworkspace.RegistrationObserveResponse{Version: benchworkspace.Version, Operation: "registration_observe", OK: true, Result: &o})
		return 200, body, nil
	case benchworkspace.PathReceipts:
		f.posts["lookup"]++
		var r benchworkspace.ReceiptLookupRequest
		_ = json.Unmarshal(raw, &r)
		result := benchworkspace.ReceiptLookupResult{TargetRequestID: r.TargetRequestID, TargetDigest: r.TargetDigest, State: "absent"}
		if f.barrier && f.effects["run"] > 0 && strings.HasPrefix(r.TargetRequestID, "run") {
			result.State = "in_progress"
			if f.barrierCancelled {
				result.State = "cancel_requested"
			}
		} else if got, ok := f.receipts[r.TargetRequestID]; ok && got.digest == r.TargetDigest && f.lookup == "" {
			result.State, result.HTTPStatus, result.ResponseBody = "completed", got.status, string(got.body)
			if f.tamperRead && strings.HasPrefix(r.TargetRequestID, "run") {
				result.ResponseBody = strings.Replace(result.ResponseBody, `"log_truncated":false`, `"log_truncated":true`, 1)
			}
		} else if f.lookup != "" {
			result.State = f.lookup
		}
		body, _ := json.Marshal(benchworkspace.ReceiptLookupResponse{Version: benchworkspace.Version, Operation: "receipt_lookup", OK: true, Result: &result})
		return 200, body, nil
	}
	var probe struct {
		Operation string `json:"operation"`
	}
	_ = json.Unmarshal(raw, &probe)
	if probe.Operation == "cancel" {
		f.posts["cancel"]++
		c, err := benchworkspace.ParseCancelRequest(raw)
		if err != nil {
			f.t.Fatal("invalid cancel sent")
		}
		f.cancels = append(f.cancels, c)
		if f.barrier {
			f.barrierCancelled = true
		}
		body, _ := json.Marshal(benchworkspace.CancelResponse{Version: benchworkspace.Version, Operation: "cancel", OK: true, Result: &benchworkspace.CancelObservation{TargetRequestID: c.TargetRequestID, TargetDigest: c.TargetDigest, State: "cancel_requested"}})
		return 200, body, nil
	}
	var request benchworkspace.Request
	var finite *benchworkspace.FiniteRunRequest
	var typed string
	if contentType == benchworkspace.FiniteContentType {
		parsed, err := benchworkspace.ParseFiniteRun(raw)
		if err != nil {
			return 400, envelope("", "", false, nil, "invalid_request"), nil
		}
		finite, request = &parsed, parsed.Request
		typed, _ = parsed.Digest()
	} else {
		parsed, err := benchworkspace.Parse(raw)
		if err != nil {
			return 400, envelope("", "", false, nil, "invalid_request"), nil
		}
		request = parsed
		typed, _ = parsed.Digest()
	}
	op := request.Operation
	f.posts[op]++
	if f.loseBefore[op] {
		delete(f.loseBefore, op)
		return 0, nil, benchworkspace.ErrLost
	}
	if benchworkspace.Growth(op) {
		if got, ok := f.receipts[request.RequestID]; ok {
			if got.digest != typed {
				return 409, envelope(op, request.RequestID, false, nil, "conflict"), nil
			}
			return got.status, got.body, nil
		}
	}
	status, body := f.act(ctx, spec, request, finite)
	if status == 0 {
		return 0, nil, benchworkspace.ErrLost
	}
	if benchworkspace.Growth(op) && (status != 409 || !strings.Contains(string(body), "in_progress")) && !(f.barrier && op == "run") {
		f.receipts[request.RequestID] = receipt{digest: typed, status: status, body: body}
	}
	if f.loseAfter[op] {
		delete(f.loseAfter, op)
		return 0, nil, benchworkspace.ErrLost
	}
	return status, body, nil
}

func (f *fakeBench) act(ctx context.Context, spec benchdispatch.SourceSpec, r benchworkspace.Request, finite *benchworkspace.FiniteRunRequest) (int, []byte) {
	op := r.Operation
	if f.capacity[op] {
		return 422, envelope(op, r.RequestID, false, nil, "capacity_exhausted")
	}
	if f.reclaim != "" && op != "status" && op != "create" {
		return 409, envelope(op, r.RequestID, false, nil, "conflict")
	}
	if op == "status" && (f.absent || f.statusDown) {
		name := "error-404-not_found"
		if f.statusDown {
			name = "error-503-unavailable"
		}
		return corpusStatusError(f.t, name)
	}
	switch op {
	case "create":
		if f.absent {
			f.absent, f.effects[op] = false, f.effects[op]+1
			m := benchworkspace.Mutation{Workspace: f.workspace(spec, false, strings.Repeat("2", 32), fakeCommitA, fakeCommitB), RootPath: "/data/benches/" + spec.BenchKey}
			return 200, envelope(op, r.RequestID, true, m, "")
		}
		if f.failCreate {
			f.failCreate, f.effects[op] = false, f.effects[op]+1
			f.stuck, f.initToken, f.stopped = "initializing", strings.Repeat("7", 32), false
			m := benchworkspace.Mutation{Workspace: f.stuckWorkspace(spec), Grant: &benchworkspace.Grant{LeaseToken: f.initToken}, RootPath: "/data/benches/" + spec.BenchKey}
			return 422, envelope(op, r.RequestID, false, m, "operation_failed")
		}
		if f.stuck != "" {
			if !f.stopped || f.holdRecreate {
				return 409, envelope(op, r.RequestID, false, nil, "conflict")
			}
			f.effects[op]++
			f.stuck, f.stopped, f.initToken = "", false, ""
			if !f.sameRecreate {
				f.benchID = strings.Repeat("5", 32)
			}
			m := benchworkspace.Mutation{Workspace: f.workspace(spec, false, strings.Repeat("2", 32), fakeCommitA, fakeCommitB), RootPath: "/data/benches/" + spec.BenchKey}
			return 200, envelope(op, r.RequestID, true, m, "")
		}
		if f.reclaim != "reclaimed" {
			return 409, envelope(op, r.RequestID, false, nil, "conflict")
		}
		f.effects[op]++
		f.reclaim, f.benchID = "", strings.Repeat("5", 32)
		m := benchworkspace.Mutation{Workspace: f.workspace(spec, false, strings.Repeat("2", 32), fakeCommitA, fakeCommitB), RootPath: "/data/benches/" + spec.BenchKey}
		return 200, envelope(op, r.RequestID, true, m, "")
	case "stop":
		if f.stuck == "" || r.LeaseToken != f.initToken {
			return 409, envelope(op, "", false, nil, "conflict")
		}
		f.effects[op]++
		f.stopped = true
		return 200, envelope(op, "", true, benchworkspace.Mutation{Workspace: f.stuckWorkspace(spec)}, "")
	case "lease":
		if f.stuck != "" {
			return 409, envelope(op, r.RequestID, false, nil, "conflict")
		}
		if f.leased {
			return 409, envelope(op, r.RequestID, false, nil, "conflict")
		}
		f.effects[op]++
		f.leased, f.holder, f.token = true, r.Holder, strings.Repeat("6", 32)
		m := benchworkspace.Mutation{Workspace: f.workspace(spec, true, strings.Repeat("2", 32), fakeCommitA, fakeCommitB), Grant: &benchworkspace.Grant{LeaseToken: f.token}, RootPath: "/data/benches/" + spec.BenchKey}
		return 200, envelope(op, r.RequestID, true, m, "")
	case "checkpoint", "release":
		if op == "release" && f.malformedRelease > 0 {
			f.malformedRelease--
			return 500, []byte(`{"ok":false,"error":{"code":"internal"}}`)
		}
		if op == "release" && f.refuseRelease > 0 {
			f.refuseRelease--
			return 409, envelope(op, "", false, nil, "conflict")
		}
		if !f.leased || r.LeaseToken != f.token {
			return 409, envelope(op, "", false, nil, "conflict")
		}
		f.effects[op]++
		if op == "release" {
			f.leased = false
			return 200, envelope(op, "", true, benchworkspace.Mutation{Workspace: f.workspace(spec, false, strings.Repeat("2", 32), fakeCommitA, fakeCommitB)}, "")
		}
		return 200, envelope(op, "", true, benchworkspace.Mutation{Workspace: f.workspace(spec, true, strings.Repeat("2", 32), fakeCommitA, fakeCommitB)}, "")
	case "status":
		w := f.workspace(spec, f.leased, strings.Repeat("2", 32), fakeCommitA, fakeCommitB)
		if f.reclaim != "" {
			w.Phase, w.ReadyForAcquisition, w.Lease = f.reclaim, false, nil
		}
		if f.stuck != "" {
			w = f.stuckWorkspace(spec)
		}
		if f.barrierCancelled && f.leased {
			phase := "stopped"
			if f.stopLag > 0 {
				f.stopLag, phase = f.stopLag-1, "running"
			}
			w.Lease = &benchworkspace.LeaseSummary{Holder: f.holder, Mode: "supervised", StopRequested: true, Execution: &benchworkspace.Execution{ID: strings.Repeat("3", 32), Phase: phase}}
		}
		inv := map[string]any{"benches": []any{benchworkspace.WorkspaceInventory{Workspace: w, Kind: "workspace", Members: []benchworkspace.Member{{Name: "a", Branch: "card/x", Base: "main", ObjectFormat: "sha1", SourceCommit: fakeCommitA}, {Name: "b", Branch: "card/x", Base: "main", ObjectFormat: "sha1", SourceCommit: fakeCommitB}}}}}
		if f.afterStatus != nil {
			f.afterStatus()
		}
		return 200, envelope(op, "", true, inv, "")
	case "run":
		if finite == nil {
			return 400, envelope(op, r.RequestID, false, nil, "invalid_request")
		}
		if !f.leased || r.LeaseToken != f.token || r.Holder != f.holder {
			return 409, envelope(op, r.RequestID, false, nil, "conflict")
		}
		stdin, _ := finite.IO.Stdin()
		body := stdin[4:]
		if len(stdin) < 4 || int(binary.BigEndian.Uint32(stdin)) != len(body) {
			f.t.Fatal("stdin is not one frame")
		}
		capsule, err := superbench.ParseRegisteredCapsule(body)
		if err != nil || len(r.Arguments) != 3 || r.Arguments[1] != Mode || r.Arguments[2] != digest(body) {
			f.t.Fatal("capsule or arguments invalid", err)
		}
		f.lastCapsule, f.runArgs = capsule, append([]string(nil), r.Arguments...)
		f.effects[op]++
		if f.barrier {
			if f.barrierReply != nil {
				return 503, f.barrierReply
			}
			return 0, nil
		}
		if f.killed != nil {
			typed, _ := finite.Digest()
			f.receipts[r.RequestID] = receipt{digest: typed, status: 503, body: f.killed}
			if f.killedLive {
				return 503, f.killed
			}
			return 0, nil
		}
		if f.inProgress[op] {
			delete(f.inProgress, op)
			// The run keeps going; its receipt completes later.
			f.receipts[r.RequestID] = f.runReceipt(spec, *finite, capsule)
			return 409, envelope(op, r.RequestID, false, nil, "in_progress")
		}
		if f.block != nil {
			if f.running != nil {
				close(f.running)
			}
			f.mu.Unlock()
			select {
			case <-f.block:
			case <-ctx.Done():
			}
			f.mu.Lock()
		}
		got := f.runReceipt(spec, *finite, capsule)
		if ctx.Err() != nil {
			typed, _ := finite.Digest()
			f.receipts[r.RequestID] = receipt{digest: typed, status: got.status, body: got.body}
			return 0, nil
		}
		return got.status, got.body
	}
	f.t.Fatal("unexpected operation", op)
	return 0, nil
}

func (f *fakeBench) runReceipt(spec benchdispatch.SourceSpec, finite benchworkspace.FiniteRunRequest, capsule superbench.RegisteredCapsule) receipt {
	var out bytes.Buffer
	_ = superbench.WriteRegisteredResult(&out, superbench.WorkerResult{Version: superbench.GroupedWorkerVersion, Binding: capsule.Task.Binding, Outcome: "complete", Handoff: map[string]string{"summary": "done"}})
	stdout := out.Bytes()
	if f.stdout != nil {
		stdout = f.stdout(stdout)
	}
	io := map[string]any{"version": benchworkspace.FiniteVersion, "stdout_base64": b64(stdout), "stdout_bytes": len(stdout), "stdout_sha256": digest(stdout)}
	exit := f.exit
	execution := benchworkspace.Execution{ID: strings.Repeat("3", 32), Phase: "stopped"}
	result := map[string]any{"execution": execution, "exit_code": exit, "log_truncated": false, "io": io}
	typed, _ := finite.Digest()
	if exit != 0 {
		w := f.workspace(spec, true, strings.Repeat("2", 32), fakeCommitA, fakeCommitB)
		w.Lease = &benchworkspace.LeaseSummary{Holder: f.holder, Mode: "supervised", Execution: &execution}
		result["workspace"] = w
		return receipt{digest: typed, status: 422, body: envelope("run", finite.RequestID, false, result, "operation_failed")}
	}
	f.leased = false
	result["workspace"] = f.workspace(spec, false, strings.Repeat("4", 32), "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", fakeCommitB)
	return receipt{digest: typed, status: 200, body: envelope("run", finite.RequestID, true, result, "")}
}

func b64(raw []byte) string { return base64.StdEncoding.EncodeToString(raw) }
