package benchremote

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
)

const (
	fakeCommitA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	fakeCommitB = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	fakeCommitE = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
	fakeToken   = "66666666666666666666666666666666"
	benchID     = "11111111111111111111111111111111"
)

// fakeBenchd is a scripted benchd on a real Unix socket. The workspace route
// speaks SuperBench v2 replies; the remote routes replay the vendored treaty
// corpus's own reply bytes. A certificate request is admitted only with the
// lease's own token, and opens (or keeps) the lease's remote execution, as
// benchd's grant does. A checkpoint, stop or release fences it.
type fakeBenchd struct {
	mu        sync.Mutex
	t         *testing.T
	key       string
	holder    string
	leased    bool
	stopped   bool
	execution string // the lease's live remote execution, "" when none
	nextExec  int
	dirty     bool // a checkpoint (and a release) finds uncommitted files
	committed bool // the agent committed since the last checkpoint: a release refuses until one is taken
	ops       []string
	keys      []string // public keys benchd was asked to sign
	issued    []byte   // the corpus's issued-certificate reply
	receipts  map[string][]byte
}

func newFakeBenchd(t *testing.T, key string) (*fakeBenchd, *benchworkspace.Client) {
	t.Helper()
	var corpus struct {
		Response struct {
			Valid map[string]json.RawMessage
		}
	}
	raw, err := os.ReadFile("../benchworkspace/testdata/remote-credentials.json")
	if err != nil || json.Unmarshal(raw, &corpus) != nil || corpus.Response.Valid["issued"] == nil {
		t.Fatal("remote corpus unreadable", err)
	}
	f := &fakeBenchd{t: t, key: key, issued: corpus.Response.Valid["issued"], receipts: map[string][]byte{}}
	dir, err := os.MkdirTemp("/tmp", "br-")
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "s")
	l, err := (&net.ListenConfig{}).Listen(t.Context(), "unix", path)
	if err != nil {
		os.RemoveAll(dir)
		t.Fatal(err)
	}
	s := &http.Server{Handler: http.HandlerFunc(f.serve), ReadHeaderTimeout: time.Second}
	done := make(chan error, 1)
	go func() { done <- s.Serve(l) }()
	client, err := benchworkspace.NewClient(path, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		client.Close()
		_ = s.Close()
		if err := <-done; !errors.Is(err, http.ErrServerClosed) {
			t.Error("fake benchd did not stop cleanly", err)
		}
		_ = os.RemoveAll(dir)
	})
	return f, client
}

func (f *fakeBenchd) count(op string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.countLocked(op)
}

func (f *fakeBenchd) countLocked(op string) int {
	n := 0
	for _, o := range f.ops {
		if o == op {
			n++
		}
	}
	return n
}

// sequence is every operation after the first n, in order.
func (f *fakeBenchd) sequence(n int) []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.ops[n:]...)
}

// restart is a benchd restart: the next certificate opens a new execution.
func (f *fakeBenchd) restart() {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.execution = ""
}

func (f *fakeBenchd) workspace(held bool, generation string, commits ...string) benchworkspace.Workspace {
	w := benchworkspace.Workspace{Key: f.key, BenchID: benchID, Phase: "ready", MemberCount: 2, CheckpointRepository: "a", ReadyForAcquisition: !held, QuotaBytes: 1 << 30, QuotaInodes: 1 << 20,
		Checkpoint: &benchworkspace.Checkpoint{GenerationID: generation, ManifestSHA256: strings.Repeat("c", 64), Members: []benchworkspace.Commit{{Name: "a", Commit: commits[0]}, {Name: "b", Commit: commits[1]}}, Seal: commits[0]}}
	if held {
		w.Lease = &benchworkspace.LeaseSummary{Holder: f.holder, Mode: "cooperative", StopRequested: f.stopped}
	}
	return w
}

func reply(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}

func envelope(op, requestID string, ok bool, result any, code, message string) []byte {
	m := map[string]any{"version": benchworkspace.Version, "operation": op, "ok": ok}
	if requestID != "" {
		m["request_id"] = requestID
	}
	if result != nil {
		m["result"] = result
	}
	if code != "" {
		m["error"] = map[string]string{"code": code, "message": message}
	}
	raw, _ := json.Marshal(m)
	return raw
}

func (f *fakeBenchd) serve(w http.ResponseWriter, r *http.Request) {
	raw, _ := io.ReadAll(r.Body)
	f.mu.Lock()
	defer f.mu.Unlock()
	switch r.URL.Path {
	case benchworkspace.PathRemoteCredentials:
		f.ops = append(f.ops, "credential")
		var req struct {
			Key        string `json:"key"`
			LeaseToken string `json:"lease_token"`
			PublicKey  string `json:"public_key"`
		}
		_ = json.Unmarshal(raw, &req)
		if !f.leased || req.LeaseToken != fakeToken || req.Key != f.key {
			reply(w, 403, []byte(`{"version":"superbench.remote.v1","operation":"writer_certificate","ok":false,"error":{"code":"forbidden","message":"lease token does not own the workspace lease"}}`))
			return
		}
		f.keys = append(f.keys, req.PublicKey)
		if f.execution == "" {
			f.nextExec++
			f.execution = fmt.Sprintf("%032x", 0xe0+f.nextExec)
		}
		reply(w, 200, f.issued)
		return
	case benchworkspace.PathRemoteStatus:
		f.ops = append(f.ops, "remote_status")
		remote := []map[string]any{}
		if f.execution != "" {
			remote = append(remote, map[string]any{"key": f.key, "bench_id": benchID, "holder": f.holder, "lease_id": strings.Repeat("2", 32), "execution_id": f.execution, "generation": 3})
		}
		body, _ := json.Marshal(map[string]any{"version": "superbench.remote.v1", "operation": "remote_status", "ok": true,
			"result": map[string]any{"address": "10.0.0.5:2222", "host_key_fingerprint": "SHA256:abc", "remote": remote, "certificates": []any{}, "sessions": []any{}}})
		reply(w, 200, body)
		return
	case benchworkspace.PathReceipts:
		f.ops = append(f.ops, "lookup")
		var lookup benchworkspace.ReceiptLookupRequest
		_ = json.Unmarshal(raw, &lookup)
		result := benchworkspace.ReceiptLookupResult{TargetRequestID: lookup.TargetRequestID, TargetDigest: lookup.TargetDigest, State: "absent"}
		body, _ := json.Marshal(benchworkspace.ReceiptLookupResponse{Version: benchworkspace.Version, Operation: "receipt_lookup", OK: true, Result: &result})
		reply(w, 200, body)
		return
	case benchworkspace.PathOperations:
	default:
		f.t.Errorf("unexpected path %s", r.URL.Path)
		reply(w, 404, []byte(`{}`))
		return
	}
	request, err := benchworkspace.Parse(raw)
	if err != nil {
		reply(w, 400, envelope("", "", false, nil, "invalid_request", "invalid"))
		return
	}
	op := request.Operation
	f.ops = append(f.ops, op)
	if body, ok := f.receipts[request.RequestID]; ok && request.RequestID != "" {
		reply(w, 200, body)
		return
	}
	owned := f.leased && request.LeaseToken == fakeToken
	switch op {
	case "status":
		inv := map[string]any{"benches": []any{benchworkspace.WorkspaceInventory{Workspace: f.workspace(f.leased, strings.Repeat("2", 32), fakeCommitA, fakeCommitB), Kind: "workspace",
			Members: []benchworkspace.Member{{Name: "a", Branch: "card/x", Base: "main", ObjectFormat: "sha1", SourceCommit: fakeCommitA}, {Name: "b", Branch: "card/x", Base: "main", ObjectFormat: "sha1", SourceCommit: fakeCommitB}}}}}
		reply(w, 200, envelope(op, "", true, inv, "", ""))
	case "lease":
		if f.leased {
			reply(w, 409, envelope(op, request.RequestID, false, nil, "conflict", "workspace state conflicts with this operation"))
			return
		}
		f.leased, f.holder, f.stopped = true, request.Holder, false
		m := benchworkspace.Mutation{Workspace: f.workspace(true, strings.Repeat("2", 32), fakeCommitA, fakeCommitB), Grant: &benchworkspace.Grant{LeaseToken: fakeToken}, RootPath: "/data/benches/" + f.key}
		body := envelope(op, request.RequestID, true, m, "", "")
		f.receipts[request.RequestID] = body
		reply(w, 200, body)
	case "checkpoint", "stop", "release":
		if !owned {
			reply(w, 409, envelope(op, "", false, nil, "conflict", "workspace state conflicts with this operation"))
			return
		}
		f.execution = "" // benchd fences the remote execution before it looks
		if op == "checkpoint" && f.dirty {
			reply(w, 409, envelope(op, "", false, nil, "conflict", "workspace has uncommitted or untracked files; commit or remove them before checkpoint or release: a/notes.txt"))
			return
		}
		// As benchd does, a release needs a clean tree whose HEAD is the complete checkpoint.
		if op == "release" && f.dirty {
			reply(w, 409, envelope(op, "", false, nil, "conflict", "workspace has uncommitted or untracked files; commit or remove them before checkpoint or release: a/notes.txt"))
			return
		}
		if op == "release" && f.committed {
			reply(w, 409, envelope(op, "", false, nil, "operation_failed", "workspace HEAD vector differs from its complete checkpoint"))
			return
		}
		switch op {
		case "checkpoint":
			f.committed = false
			generation, commit := strings.Repeat("2", 32), fakeCommitA
			if f.countLocked("checkpoint") > 1 {
				generation, commit = strings.Repeat("4", 32), fakeCommitE
			}
			reply(w, 200, envelope(op, "", true, benchworkspace.Mutation{Workspace: f.workspace(true, generation, commit, fakeCommitB)}, "", ""))
		case "stop":
			f.stopped = true
			reply(w, 200, envelope(op, "", true, benchworkspace.Mutation{Workspace: f.workspace(true, strings.Repeat("4", 32), fakeCommitE, fakeCommitB)}, "", ""))
		case "release":
			f.leased = false
			reply(w, 200, envelope(op, "", true, benchworkspace.Mutation{Workspace: f.workspace(false, strings.Repeat("4", 32), fakeCommitE, fakeCommitB)}, "", ""))
		}
	default:
		f.t.Errorf("unexpected operation %s", op)
		reply(w, 400, envelope(op, "", false, nil, "invalid_request", "invalid"))
	}
}
