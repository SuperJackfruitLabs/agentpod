package benchdispatch

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/superbench"
)

func TestCorruptPrivateStateFailsClosed(t *testing.T) {
	for _, tc := range []string{"duplicate", "unknown", "null", "trailing", "oversize", "symlink", "public", "directory", "invalid-phase", "false-active", "changed-proposal"} {
		t.Run(tc, func(t *testing.T) {
			s, p, raw := fixture(t)
			prepare(t, s, p)
			path := filepath.Join(s.Root, digest([]byte(p.BenchKey))+".json")
			original, e := os.ReadFile(path)
			if e != nil {
				t.Fatal(e)
			}
			switch tc {
			case "duplicate":
				original = []byte(`{"version":"` + version + `","version":"` + version + `"}`)
			case "unknown":
				original = append(original[:len(original)-1], []byte(`,"foreign":true}`)...)
			case "null":
				original = []byte(`{"version":null}`)
			case "trailing":
				original = append(original, []byte(" {}")...)
			case "oversize":
				original = []byte(strings.Repeat(" ", maxState+1))
			case "symlink":
				if e = os.Rename(path, path+".original"); e != nil {
					t.Fatal(e)
				}
				if e = os.Symlink(path+".original", path); e != nil {
					t.Fatal(e)
				}
			case "public":
				if e = os.Chmod(path, 0644); e != nil {
					t.Fatal(e)
				}
			case "directory":
				if e = os.Remove(path); e != nil {
					t.Fatal(e)
				}
				if e = os.Mkdir(path, 0700); e != nil {
					t.Fatal(e)
				}
			case "invalid-phase":
				original = []byte(strings.Replace(string(original), `"phase":"prepared"`, `"phase":"released"`, 1))
			case "false-active":
				var doc state
				_ = json.Unmarshal(original, &doc)
				doc.Active = strings.Repeat("b", 64)
				original, _ = json.Marshal(doc)
			case "changed-proposal":
				dispatch(t, s, p, raw)
				if _, e = s.StageProposal(context.Background(), p, observation(p), allow, verified); e != nil {
					t.Fatal(e)
				}
				original, e = os.ReadFile(path)
				if e != nil {
					t.Fatal(e)
				}
				original = []byte(strings.Replace(string(original), `"execution_id":"execution-attempt-1"`, `"execution_id":"forged"`, 1))
			}
			if tc != "symlink" && tc != "public" && tc != "directory" {
				// #nosec G703 -- corrupt only the exact private fixture file created above.
				if e = os.WriteFile(path, original, 0600); e != nil {
					t.Fatal(e)
				}
			}
			if _, e = s.Inspect(context.Background(), p); !errors.Is(e, ErrInvalid) {
				t.Fatal("corruption accepted", e)
			}
		})
	}
}
func TestUnsafeRootAndLockNeverFollowed(t *testing.T) {
	for _, tc := range []string{"root-symlink", "root-public", "lock-symlink", "lock-public"} {
		t.Run(tc, func(t *testing.T) {
			s, p, _ := fixture(t)
			target := filepath.Join(filepath.Dir(s.Root), "unrelated")
			if e := os.WriteFile(target, []byte("untouched"), 0600); e != nil {
				t.Fatal(e)
			}
			switch tc {
			case "root-symlink":
				if e := os.Symlink(filepath.Dir(s.Root), s.Root); e != nil {
					t.Fatal(e)
				}
			case "root-public":
				if e := os.Mkdir(s.Root, 0755); e != nil {
					t.Fatal(e)
				}
			default:
				prepare(t, s, p)
				lockPath := filepath.Join(s.Root, digest([]byte(p.BenchKey))+".lock")
				if tc == "lock-public" {
					if e := os.Chmod(lockPath, 0644); e != nil {
						t.Fatal(e)
					}
				} else {
					if e := os.Remove(lockPath); e != nil {
						t.Fatal(e)
					}
					if e := os.Symlink(target, lockPath); e != nil {
						t.Fatal(e)
					}
				}
			}
			if e := s.Prepare(context.Background(), p); !errors.Is(e, ErrInvalid) {
				t.Fatal("unsafe path accepted", e)
			}
			b, e := os.ReadFile(target)
			if e != nil || string(b) != "untouched" {
				t.Fatal("unrelated file changed", e)
			}
		})
	}
}
func TestLockWaitRespectsCancellation(t *testing.T) {
	s, p, _ := fixture(t)
	prepare(t, s, p)
	path := filepath.Join(s.Root, digest([]byte(p.BenchKey))+".lock")
	f, e := os.OpenFile(path, os.O_RDWR, 0600)
	if e != nil {
		t.Fatal(e)
	}
	defer f.Close()
	unlock, e := lock(context.Background(), f)
	if e != nil {
		t.Fatal(e)
	}
	defer unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Millisecond)
	defer cancel()
	if _, e = s.Inspect(ctx, p); e == nil {
		t.Fatal("contended lock ignored cancellation")
	}
}
func TestBoundedPrivateDecoder(t *testing.T) {
	for _, raw := range []string{strings.Repeat("[", 130) + strings.Repeat("]", 130), `{"nested":{"x":1,"x":2}}`, `{"nested":null}`, `{} {}`, `{"a":[]`, string([]byte{0xff})} {
		var value map[string]any
		if e := decode([]byte(raw), &value); e == nil {
			t.Fatal("invalid state decoded")
		}
	}
}
func TestSameSHASecondRunNeedsOwnLaunchAndResult(t *testing.T) {
	s, p, raw := fixture(t)
	prepare(t, s, p)
	dispatch(t, s, p, raw)
	first, e := s.StageProposal(context.Background(), p, observation(p), allow, verified)
	if e != nil {
		t.Fatal(e)
	}
	next := p
	next.Identity.RunID = "run-2"
	next.Identity.AttemptID = "attempt-2"
	next.Identity.Epoch++
	next.RequestID = "request-2"
	next.Holder = "board/run-2/4"
	parent := filepath.Dir(s.Root)
	contextPath, e := superbench.PrepareWorker(parent, superbench.WorkerSpec{Version: superbench.WorkerVersion, Binding: superbench.Binding{BoardID: next.Identity.BoardID, CardID: next.Identity.CardID, RunID: next.Identity.RunID, Epoch: next.Identity.Epoch}, Directory: parent, Arguments: []string{"/bin/sh", "-c", "exit 0"}, TimeoutSeconds: 30})
	if e != nil {
		t.Fatal(e)
	}
	contextRaw, e := os.ReadFile(filepath.Join(contextPath, "request.json"))
	if e != nil {
		t.Fatal(e)
	}
	next.ContextPath = contextPath
	next.ContextSHA256 = digest(contextRaw)
	cp := true
	request := superbench.Request{Version: superbench.Version, Operation: "run", Key: next.BenchKey, Holder: next.Holder, RequestID: next.RequestID, Arguments: []string{next.ExecutablePath, next.ContextPath}, Checkpoint: &cp}
	raw, _ = json.Marshal(request)
	next.RequestSHA256 = digest(raw)
	next.BodySHA256, _ = request.Digest()
	prepare(t, s, next)
	called := false
	if e = s.Dispatch(context.Background(), next, raw, allow, func(context.Context) error { called = true; return nil }); e != nil || !called {
		t.Fatal(e)
	}
	reused := observation(next)
	reused.ExecutionID = observation(p).ExecutionID
	if _, e = s.StageProposal(context.Background(), next, reused, allow, verified); !errors.Is(e, ErrConflict) {
		t.Fatal("prior execution relabeled to newrun", e)
	}
	second, e := s.StageProposal(context.Background(), next, observation(next), allow, verified)
	if e != nil || string(first) == string(second) {
		t.Fatal("newrun did not receive distinct immutable proof", e)
	}
	if next.Sources[0].Commit != p.Sources[0].Commit {
		t.Fatal("fixture lost sameSHA case")
	}
}
func TestAttemptCannotRenameSameRunOrReuseRequest(t *testing.T) {
	s, p, raw := fixture(t)
	prepare(t, s, p)
	dispatch(t, s, p, raw)
	if _, e := s.StageProposal(context.Background(), p, observation(p), allow, verified); e != nil {
		t.Fatal(e)
	}
	next := p
	next.Identity.AttemptID = "new-attempt"
	next.RequestID = "new-request"
	if e := s.Prepare(context.Background(), next); !errors.Is(e, ErrConflict) {
		t.Fatal("same run renamed", e)
	}
	next.Identity.RunID = "new-run"
	next.RequestID = p.RequestID
	if e := s.Prepare(context.Background(), next); !errors.Is(e, ErrConflict) {
		t.Fatal("request reused", e)
	}
}

func TestAdmissionAndProofDenialDoNotLaunchOrRelease(t *testing.T) {
	s, p, raw := fixture(t)
	prepare(t, s, p)
	called := false
	deny := func(context.Context, Plan) error { return errors.New("private authorization detail") }
	if e := s.Dispatch(context.Background(), p, raw, deny, func(context.Context) error { called = true; return nil }); !errors.Is(e, ErrOwner) || called {
		t.Fatal("denied gate launched", e)
	}
	r, e := s.Inspect(context.Background(), p)
	if e != nil || r.Phase != "prepared" {
		t.Fatal(e)
	}
	dispatch(t, s, p, raw)
	if _, e = s.StageProposal(context.Background(), p, observation(p), allow, func(context.Context, Plan, Observation) error { return errors.New("private response") }); !errors.Is(e, ErrVerify) {
		t.Fatal(e)
	}
	r, e = s.Inspect(context.Background(), p)
	if e != nil || r.Phase != "pending" || len(r.Proposal) != 0 {
		t.Fatal("unverified proof released reservation", e)
	}
}
func TestMissingActiveReservationIsCorruption(t *testing.T) {
	s, p, _ := fixture(t)
	prepare(t, s, p)
	path := filepath.Join(s.Root, digest([]byte(p.BenchKey))+".json")
	raw, e := os.ReadFile(path)
	if e != nil {
		t.Fatal(e)
	}
	var doc state
	if e = json.Unmarshal(raw, &doc); e != nil {
		t.Fatal(e)
	}
	doc.Active = ""
	raw, _ = json.Marshal(doc)
	if e = os.WriteFile(path, raw, 0600); e != nil {
		t.Fatal(e)
	}
	if _, e = s.Inspect(context.Background(), p); !errors.Is(e, ErrInvalid) {
		t.Fatal("unreleased record lost active reservation", e)
	}
}

func TestPendingArtifactRemovalDoesNotLookSafeToRetry(t *testing.T) {
	s, p, raw := fixture(t)
	prepare(t, s, p)
	dispatch(t, s, p, raw)
	if e := os.Remove(p.ExecutablePath); e != nil {
		t.Fatal(e)
	}
	called := false
	if e := s.Dispatch(context.Background(), p, raw, allow, func(context.Context) error { called = true; return nil }); !errors.Is(e, ErrPending) || called {
		t.Fatal("lost reply ceased being pending after mutable artifact changed", e)
	}
}
