package benchdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchworkspace"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

func groupedFixture(t *testing.T) (Store, Plan, []byte) {
	t.Helper()
	s, p, _ := fixture(t)
	p.Identity.BoardID = "brd_example1"
	p.Identity.CardID = "card_example1"
	p.Identity.RunID = "run_example1"
	p.RegistrationID = strings.Repeat("b", 32)
	root := filepath.Join(filepath.Dir(p.ContextPath), "data", "benches", p.BenchKey)
	members := []superbench.GroupedMember{{Name: "a", RepositorySHA256: digest([]byte("repo-a")), TaskRef: "refs/heads/card/card_example1", ObjectFormat: "sha1", Commit: strings.Repeat("a", 40)}, {Name: "b", RepositorySHA256: digest([]byte("repo-b")), TaskRef: "refs/heads/card/card_example1", ObjectFormat: "sha256", Commit: strings.Repeat("b", 64)}}
	spec := superbench.GroupedWorkerSpec{Version: superbench.GroupedWorkerVersion, Binding: superbench.Binding{BoardID: p.Identity.BoardID, CardID: p.Identity.CardID, RunID: p.Identity.RunID, Epoch: p.Identity.Epoch}, BenchKey: p.BenchKey, BenchID: p.RegistrationID, WorkspaceRoot: root, RepositoryName: "b", Members: members, Arguments: []string{"/bin/sh", "-c", "exit 0"}, Prompt: "private prompt", Environment: map[string]string{}, TimeoutSeconds: 30}
	dir, hash, err := superbench.PrepareGroupedWorker(filepath.Dir(p.ContextPath), spec)
	if err != nil {
		t.Fatal(err)
	}
	p.ContextPath = dir
	p.ContextSHA256 = hash
	p.Sources = nil
	for _, m := range members {
		p.Sources = append(p.Sources, Source{Name: m.Name, RepositorySHA256: m.RepositorySHA256, TaskRef: m.TaskRef, Commit: m.Commit})
	}
	// Decode the additive descriptor as durable JSON so the pre-change ledger
	// compiles and demonstrates rejection of the actual grouped service launch.
	rawPlan, _ := json.Marshal(p)
	var object map[string]any
	_ = json.Unmarshal(rawPlan, &object)
	object["grouped"] = map[string]any{"workspace_root": root, "repository_name": "b", "members": members}
	rawPlan, _ = json.Marshal(object)
	if json.Unmarshal(rawPlan, &p) != nil {
		t.Fatal("plan")
	}
	yes := true
	r := benchworkspace.Request{Version: benchworkspace.Version, Operation: "run", Key: p.BenchKey, Holder: p.Holder, RequestID: p.RequestID, LeaseToken: strings.Repeat("d", 48), Checkpoint: &yes, Arguments: []string{p.ExecutablePath, p.ContextPath, p.ContextSHA256}}
	raw, err := json.Marshal(r)
	if err != nil {
		t.Fatal(err)
	}
	p.RequestSHA256 = digest(raw)
	p.BodySHA256, err = r.Digest()
	if err != nil {
		t.Fatal(err)
	}
	return s, p, raw
}

func TestProtectedGroupedLaunchBindsCompleteContextAndRunsOnce(t *testing.T) {
	s, p, raw := groupedFixture(t)
	prepare(t, s, p)
	calls := 0
	launch := func(context.Context) error { calls++; return nil }
	if err := s.Dispatch(context.Background(), p, raw, allow, launch); err != nil {
		t.Fatal("actual grouped launch rejected", err)
	}
	if err := s.Dispatch(context.Background(), p, raw, allow, launch); !errors.Is(err, ErrPending) || calls != 1 {
		t.Fatal("grouped redispatch", err, calls)
	}
	stored, err := os.ReadFile(filepath.Join(s.Root, digest([]byte(p.BenchKey))+".json"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(stored), strings.Repeat("d", 48)) {
		t.Fatal("token entered ordinary ledger")
	}
}

func TestProtectedGroupedRejectsMutatedLaunchBeforeEffect(t *testing.T) {
	for _, name := range []string{"third-argument", "missing-token", "selected-service-cwd", "no-checkpoint", "old-worker-context", "changed-context", "changed-vector", "changed-format", "changed-root"} {
		t.Run(name, func(t *testing.T) {
			s, p, raw := groupedFixture(t)
			root, err := os.OpenRoot(p.ContextPath)
			if err != nil {
				t.Fatal(err)
			}
			defer root.Close()
			writeContext := func(b []byte) {
				t.Helper()
				if err := root.WriteFile("request.json", b, 0600); err != nil {
					t.Fatal(err)
				}
			}
			var r benchworkspace.Request
			if json.Unmarshal(raw, &r) != nil {
				t.Fatal("request")
			}
			switch name {
			case "third-argument":
				r.Arguments[2] = strings.Repeat("e", 64)
			case "missing-token":
				r.LeaseToken = ""
			case "selected-service-cwd":
				r.RepositoryName = "b"
			case "no-checkpoint":
				no := false
				r.Checkpoint = &no
			case "old-worker-context":
				b, _ := os.ReadFile(filepath.Join(p.ContextPath, "request.json"))
				b = []byte(strings.Replace(string(b), superbench.GroupedWorkerVersion, superbench.WorkerVersion, 1))
				writeContext(b)
				p.ContextSHA256 = digest(b)
				r.Arguments[2] = p.ContextSHA256
			case "changed-context":
				f := filepath.Join(p.ContextPath, "request.json")
				b, _ := os.ReadFile(f)
				writeContext(append(b, ' '))
			case "changed-vector", "changed-format", "changed-root":
				b, _ := os.ReadFile(filepath.Join(p.ContextPath, "request.json"))
				var spec superbench.GroupedWorkerSpec
				_ = json.Unmarshal(b, &spec)
				switch name {
				case "changed-vector":
					spec.Members[1].Commit = strings.Repeat("e", 64)
				case "changed-format":
					spec.Members[1].ObjectFormat = "sha1"
				default:
					spec.WorkspaceRoot += "-other"
				}
				b, _ = json.Marshal(spec)
				writeContext(b)
				p.ContextSHA256 = digest(b)
				r.Arguments[2] = p.ContextSHA256
			}
			raw, _ = json.Marshal(r)
			p.RequestSHA256 = digest(raw)
			if d, e := r.Digest(); e == nil {
				p.BodySHA256 = d
			}
			prepare(t, s, p)
			called := false
			if err := s.Dispatch(context.Background(), p, raw, allow, func(context.Context) error { called = true; return nil }); err == nil || called {
				t.Fatal("mutated grouped launch escaped", name, err)
			}
		})
	}
}

func TestGroupedPlanAndProposalCannotRelabelStartOrScalarOutcome(t *testing.T) {
	s, p, raw := groupedFixture(t)
	prepare(t, s, p)
	altered := p
	g := *p.Grouped
	g.Members = append([]superbench.GroupedMember(nil), g.Members...)
	altered.Grouped = &g
	altered.Sources = append([]Source(nil), p.Sources...)
	g.Members[1].Commit = strings.Repeat("e", 64)
	altered.Sources[1].Commit = g.Members[1].Commit
	if err := s.Prepare(context.Background(), altered); !errors.Is(err, ErrConflict) {
		t.Fatal("immutable start vector rebound", err)
	}
	dispatch(t, s, p, raw)
	o := observation(p)
	if _, err := s.StageProposal(context.Background(), p, o, allow, verified); !errors.Is(err, ErrVerify) {
		t.Fatal("scalar outcome relabeled grouped attempt", err)
	}
	o.Kind = "grouped-v2"
	o.GenerationID = strings.Repeat("a", 32)
	o.SealCommit = strings.Repeat("b", 40)
	o.ManifestSHA256 = strings.Repeat("c", 64)
	// Payload commits may legitimately differ from the protected start vector.
	o.Checkpoints[1].Commit = strings.Repeat("e", 64)
	proof, err := s.StageProposal(context.Background(), p, o, allow, verified)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := s.StageProposal(context.Background(), p, o, allow, func(context.Context, Plan, Observation) error { t.Fatal("historical proposal reverified"); return nil })
	if err != nil || string(replay) != string(proof) {
		t.Fatal("grouped immutable replay", err)
	}
}

func TestScalarPlanStillOmitsGroupedDescriptor(t *testing.T) {
	_, p, raw := fixture(t)
	serialized, err := json.Marshal(p)
	if err != nil || strings.Contains(string(serialized), `"grouped"`) {
		t.Fatal("scalar plan bytes gained descriptor", err)
	}
	if err = validateLaunch(p, raw); err != nil {
		t.Fatal("scalar launch changed", err)
	}
}
