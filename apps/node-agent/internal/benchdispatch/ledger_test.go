package benchdispatch

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

func fixture(t *testing.T) (Store, Plan, []byte) {
	t.Helper()
	parent, e := filepath.EvalSymlinks(t.TempDir())
	if e != nil {
		t.Fatal(e)
	}
	if e = os.Chmod(parent, 0700); e != nil {
		t.Fatal(e)
	}
	helper := filepath.Join(parent, "worker")
	binary := []byte("#!/bin/sh\nexit 0\n")
	if e = os.WriteFile(helper, binary, 0700); e != nil {
		t.Fatal(e)
	}
	b := superbench.Binding{BoardID: "board", CardID: "card", RunID: "run", Epoch: 3}
	contextPath, e := superbench.PrepareWorker(parent, superbench.WorkerSpec{Version: superbench.WorkerVersion, Binding: b, Directory: parent, Arguments: []string{"/bin/sh", "-c", "exit 0"}, TimeoutSeconds: 30})
	if e != nil {
		t.Fatal(e)
	}
	contextRaw, e := os.ReadFile(filepath.Join(contextPath, "request.json"))
	if e != nil {
		t.Fatal(e)
	}
	cp := true
	r := superbench.Request{Version: superbench.Version, Operation: "run", Key: "card-bench", Holder: "board/run/3", RequestID: "request-1", Arguments: []string{helper, contextPath}, Checkpoint: &cp}
	raw, e := json.Marshal(r)
	if e != nil {
		t.Fatal(e)
	}
	body, e := r.Digest()
	if e != nil {
		t.Fatal(e)
	}
	p := Plan{Identity: Identity{TenantID: "tenant", BoardID: b.BoardID, CardID: b.CardID, StageID: "write", RunID: b.RunID, Epoch: b.Epoch, AgentID: "executor", StationID: "station", NodeID: "node", AttemptID: "attempt-1", ControlPrincipalID: "principal", ControlGrantID: "control-grant", PolicySHA256: digest([]byte("policy"))}, HostID: "host", BenchKey: r.Key, RegistrationID: "registered-bench", Holder: r.Holder, Sources: []Source{{Name: "repo", RepositorySHA256: digest([]byte("authorized-repo")), TaskRef: "refs/heads/card/card", Commit: strings.Repeat("a", 40)}}, RequestID: r.RequestID, RequestSHA256: digest(raw), BodySHA256: body, ContextPath: contextPath, ContextSHA256: digest(contextRaw), ExecutablePath: helper, ExecutableSHA256: digest(binary)}
	if e = validatePlan(p); e != nil {
		t.Fatal(e)
	}
	return Store{Root: filepath.Join(parent, "ledger")}, p, raw
}
func allow(context.Context, Plan) error                 { return nil }
func verified(context.Context, Plan, Observation) error { return nil }
func observation(p Plan) Observation {
	return Observation{RequestID: p.RequestID, RequestSHA256: p.RequestSHA256, BodySHA256: p.BodySHA256, ResponseSHA256: digest([]byte("trusted response")), WorkerResultSHA256: digest([]byte("worker result")), ExecutionID: "execution-" + p.Identity.AttemptID, Stopped: true, Released: true, Checkpoints: append([]Source(nil), p.Sources...), Kind: "scalar-v1"}
}
func prepare(t *testing.T, s Store, p Plan) {
	t.Helper()
	if e := s.Prepare(context.Background(), p); e != nil {
		t.Fatal(e)
	}
}
func dispatch(t *testing.T, s Store, p Plan, raw []byte) {
	t.Helper()
	if e := s.Dispatch(context.Background(), p, raw, allow, func(context.Context) error { return nil }); e != nil {
		t.Fatal(e)
	}
}

func TestMissingGateCannotLaunch(t *testing.T) {
	s, p, raw := fixture(t)
	called := false
	if e := s.Dispatch(context.Background(), p, raw, nil, func(context.Context) error { called = true; return nil }); e == nil || called {
		t.Fatal("missing authority launched")
	}
	if _, e := os.Stat(s.Root); !os.IsNotExist(e) {
		t.Fatal("invalid dispatch created state")
	}
}
func TestPendingNeverRedispatchesAndExactReplay(t *testing.T) {
	s, p, raw := fixture(t)
	prepare(t, s, p)
	var calls int
	launch := func(context.Context) error { calls++; return errors.New("secret raw service failure") }
	if e := s.Dispatch(context.Background(), p, raw, allow, launch); !errors.Is(e, ErrPending) || strings.Contains(e.Error(), "secret") {
		t.Fatal(e)
	}
	s = Store{Root: s.Root}
	if e := s.Dispatch(context.Background(), p, raw, allow, launch); !errors.Is(e, ErrPending) || calls != 1 {
		t.Fatal("redispatched", e, calls)
	}
	if _, e := s.StageProposal(context.Background(), p, observation(p), allow, nil); !errors.Is(e, ErrVerify) {
		t.Fatal(e)
	}
	result, e := s.StageProposal(context.Background(), p, observation(p), allow, verified)
	if e != nil {
		t.Fatal(e)
	}
	replay, e := s.StageProposal(context.Background(), p, observation(p), allow, func(context.Context, Plan, Observation) error { t.Fatal("reverified immutable replay"); return nil })
	if e != nil || !bytes.Equal(result, replay) {
		t.Fatal("replay changed", e)
	}
	mutated := observation(p)
	mutated.ExecutionID = "different"
	if _, e = s.StageProposal(context.Background(), p, mutated, allow, verified); !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	if e = s.Dispatch(context.Background(), p, raw, allow, launch); e == nil || calls != 1 {
		t.Fatal("completed attempt relaunched", e)
	}
}
func TestSameCheckpointNewRunGetsNewProofNoAdoption(t *testing.T) {
	s, p, raw := fixture(t)
	prepare(t, s, p)
	dispatch(t, s, p, raw)
	old, e := s.StageProposal(context.Background(), p, observation(p), allow, verified)
	if e != nil {
		t.Fatal(e)
	}
	next := p
	next.Identity.RunID = "new-run"
	next.Identity.AttemptID = "attempt-2"
	next.Identity.Epoch++
	next.RequestID = "request-2"
	prepare(t, s, next)
	if _, e = s.StageProposal(context.Background(), next, observation(next), allow, verified); !errors.Is(e, ErrOwner) {
		t.Fatal("prepared newrun adopted earlier evidence", e)
	}
	// The stale owner cannot change the next owner's active pointer.
	if e = s.Supersede(context.Background(), p); !errors.Is(e, ErrOwner) {
		t.Fatal(e)
	}
	r, e := s.Inspect(context.Background(), next)
	if e != nil || r.Phase != "prepared" {
		t.Fatal(e, r.Phase)
	}
	replay, e := s.StageProposal(context.Background(), p, observation(p), allow, verified)
	if e != nil || !bytes.Equal(old, replay) {
		t.Fatal(e)
	}
}
func TestPendingAndSupersededCannotBeReclaimed(t *testing.T) {
	s, p, raw := fixture(t)
	prepare(t, s, p)
	dispatch(t, s, p, raw)
	next := p
	next.Identity.RunID = "next"
	next.RequestID = "request-next"
	next.Identity.AttemptID = "next"
	if e := s.Prepare(context.Background(), next); !errors.Is(e, ErrPending) {
		t.Fatal(e)
	}
	if e := s.Supersede(context.Background(), p); e != nil {
		t.Fatal(e)
	}
	if e := s.Prepare(context.Background(), next); !errors.Is(e, ErrPending) {
		t.Fatal("superseded uncertain writer freed", e)
	}
	if _, e := s.StageProposal(context.Background(), p, observation(p), allow, verified); !errors.Is(e, ErrOwner) {
		t.Fatal("superseded settled", e)
	}
}
func TestPostAwaitOwnerRecheck(t *testing.T) {
	s, p, raw := fixture(t)
	prepare(t, s, p)
	dispatch(t, s, p, raw)
	verify := func(context.Context, Plan, Observation) error { return s.Supersede(context.Background(), p) }
	if _, e := s.StageProposal(context.Background(), p, observation(p), allow, verify); !errors.Is(e, ErrOwner) {
		t.Fatal("supersession during await accepted", e)
	}
	r, e := s.Inspect(context.Background(), p)
	if e != nil || r.Phase != "superseded" {
		t.Fatal(e)
	}
}
func TestGateRecheckedAfterAsyncVerification(t *testing.T) {
	s, p, raw := fixture(t)
	prepare(t, s, p)
	dispatch(t, s, p, raw)
	current := true
	gate := func(context.Context, Plan) error {
		if !current {
			return ErrOwner
		}
		return nil
	}
	verify := func(context.Context, Plan, Observation) error { current = false; return nil }
	if _, e := s.StageProposal(context.Background(), p, observation(p), gate, verify); !errors.Is(e, ErrOwner) {
		t.Fatal(e)
	}
}
func TestConcurrentLaunchOnlyOnce(t *testing.T) {
	s, p, raw := fixture(t)
	prepare(t, s, p)
	var launched atomic.Int32
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() {
			_ = s.Dispatch(context.Background(), p, raw, allow, func(context.Context) error { launched.Add(1); return nil })
		})
	}
	wg.Wait()
	if launched.Load() != 1 {
		t.Fatal("multiple launches", launched.Load())
	}
}
func TestPreparedIdentityImmutable(t *testing.T) {
	s, p, _ := fixture(t)
	prepare(t, s, p)
	for _, change := range []func(*Plan){func(p *Plan) { p.HostID = "other" }, func(p *Plan) { p.Sources[0].Commit = strings.Repeat("b", 40) }, func(p *Plan) { p.Identity.PolicySHA256 = digest([]byte("new-policy")) }} {
		next := p
		next.Sources = append([]Source(nil), p.Sources...)
		change(&next)
		if e := s.Prepare(context.Background(), next); e == nil {
			t.Fatal("conflicting plan accepted")
		}
	}
}
func TestLaunchArtifactAndRequestTampering(t *testing.T) {
	for _, test := range []string{"body", "context", "executable", "requestid", "checkpointfalse", "symlink"} {
		t.Run(test, func(t *testing.T) {
			s, p, raw := fixture(t)
			prepare(t, s, p)
			switch test {
			case "body":
				raw = append(raw, ' ')
			case "context":
				if e := os.WriteFile(filepath.Join(p.ContextPath, "request.json"), []byte("{}"), 0600); e != nil {
					t.Fatal(e)
				}
			case "executable":
				if e := os.WriteFile(p.ExecutablePath, []byte("changed"), 0700); e != nil {
					t.Fatal(e)
				}
			case "requestid":
				var r superbench.Request
				if e := json.Unmarshal(raw, &r); e != nil {
					t.Fatal(e)
				}
				r.RequestID = "foreign"
				raw, _ = json.Marshal(r)
				p.RequestSHA256 = digest(raw)
			case "checkpointfalse":
				var r superbench.Request
				_ = json.Unmarshal(raw, &r)
				f := false
				r.Checkpoint = &f
				raw, _ = json.Marshal(r)
				p.RequestSHA256 = digest(raw)
				p.BodySHA256, _ = r.Digest()
			case "symlink":
				target := p.ExecutablePath + ".moved"
				if e := os.Rename(p.ExecutablePath, target); e != nil {
					t.Fatal(e)
				}
				if e := os.Symlink(target, p.ExecutablePath); e != nil {
					t.Fatal(e)
				}
			}
			called := false
			if e := s.Dispatch(context.Background(), p, raw, allow, func(context.Context) error { called = true; return nil }); e == nil || called {
				t.Fatal("tampering launched")
			}
		})
	}
}
func TestObservationMismatchRefused(t *testing.T) {
	changes := []func(*Observation){func(o *Observation) { o.RequestID = "foreign" }, func(o *Observation) { o.Stopped = false }, func(o *Observation) { o.Released = false }, func(o *Observation) { o.BodySHA256 = digest(nil) }, func(o *Observation) { o.Checkpoints[0].TaskRef = "refs/heads/other" }, func(o *Observation) { o.WorkerResultSHA256 = "" }, func(o *Observation) { o.Kind = "grouped-v2" }, func(o *Observation) { o.GenerationID = strings.Repeat("a", 32) }}
	for i, change := range changes {
		t.Run(fmt.Sprint(i), func(t *testing.T) {
			s, p, raw := fixture(t)
			prepare(t, s, p)
			dispatch(t, s, p, raw)
			o := observation(p)
			change(&o)
			if _, e := s.StageProposal(context.Background(), p, o, allow, verified); !errors.Is(e, ErrVerify) {
				t.Fatal(e)
			}
		})
	}
}
func TestCapabilityNeverOrdinaryJSONAndCannotFollowNewOwner(t *testing.T) {
	s, p, raw := fixture(t)
	prepare(t, s, p)
	dispatch(t, s, p, raw)
	token := strings.Repeat("c", 48)
	capability, e := NewCapability(token)
	if e != nil {
		t.Fatal(e)
	}
	for _, formatted := range []string{fmt.Sprint(capability), fmt.Sprintf("%#v", capability), fmt.Sprintf("%+v", capability)} {
		if strings.Contains(formatted, token) {
			t.Fatal("token formatted")
		}
	}
	if _, e = json.Marshal(capability); e == nil {
		t.Fatal("token serializable")
	}
	if e = s.RetainCapability(context.Background(), p, capability); e != nil {
		t.Fatal(e)
	}
	got, e := s.Capability(context.Background(), p)
	if e != nil {
		t.Fatal(e)
	}
	if e = got.Use(func(s string) error {
		if s != token {
			t.Fatal("wrong token")
		}
		return nil
	}); e != nil {
		t.Fatal(e)
	}
	r, e := s.Inspect(context.Background(), p)
	if e != nil {
		t.Fatal(e)
	}
	view, _ := json.Marshal(r)
	if strings.Contains(string(view), token) {
		t.Fatal("token projection")
	}
	other, _ := NewCapability(strings.Repeat("d", 48))
	if e = s.RetainCapability(context.Background(), p, other); !errors.Is(e, ErrConflict) {
		t.Fatal(e)
	}
	if _, e = s.StageProposal(context.Background(), p, observation(p), allow, verified); e != nil {
		t.Fatal(e)
	}
	next := p
	next.Identity.AttemptID = "new"
	next.Identity.RunID = "new"
	next.RequestID = "request-new"
	prepare(t, s, next)
	if _, e = s.Capability(context.Background(), p); !errors.Is(e, ErrOwner) {
		t.Fatal("old grant exposed after release", e)
	}
	if _, e = s.Capability(context.Background(), next); e == nil {
		t.Fatal("adopted foreign grant")
	}
}
func TestCrashAfterDurableIntentNeverRedispatch(t *testing.T) {
	if os.Getenv("BENCHDISPATCH_TEST_CRASH") == "1" {
		raw := []byte(os.Getenv("BENCHDISPATCH_TEST_PLAN"))
		var p Plan
		if json.Unmarshal(raw, &p) != nil {
			os.Exit(3)
		}
		request := []byte(os.Getenv("BENCHDISPATCH_TEST_REQUEST"))
		_ = (Store{Root: os.Getenv("BENCHDISPATCH_TEST_ROOT")}).Dispatch(context.Background(), p, request, allow, func(context.Context) error { os.Exit(42); return nil })
		os.Exit(4)
	}
	s, p, raw := fixture(t)
	prepare(t, s, p)
	planRaw, _ := json.Marshal(p)
	planPath := filepath.Join(filepath.Dir(s.Root), "plan.json")
	requestPath := filepath.Join(filepath.Dir(s.Root), "request.json")
	if e := os.WriteFile(planPath, planRaw, 0600); e != nil {
		t.Fatal(e)
	}
	if e := os.WriteFile(requestPath, raw, 0600); e != nil {
		t.Fatal(e)
	}
	executable, e := os.Executable()
	if e != nil {
		t.Fatal(e)
	}
	childCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(childCtx, executable, "-test.run=^TestCrashAfterDurableIntentNeverRedispatch$")
	cmd.Env = append(os.Environ(), "BENCHDISPATCH_TEST_CRASH=1", "BENCHDISPATCH_TEST_PLAN="+string(planRaw), "BENCHDISPATCH_TEST_REQUEST="+string(raw), "BENCHDISPATCH_TEST_ROOT="+s.Root)
	e = cmd.Run()
	var exit *exec.ExitError
	if !errors.As(e, &exit) || exit.ExitCode() != 42 {
		t.Fatal("crash fixture failed", e)
	}
	called := false
	if e = s.Dispatch(context.Background(), p, raw, allow, func(context.Context) error { called = true; return nil }); !errors.Is(e, ErrPending) || called {
		t.Fatal("crashed run redispatched", e)
	}
}
