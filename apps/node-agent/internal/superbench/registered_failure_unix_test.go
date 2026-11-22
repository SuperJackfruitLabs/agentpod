//go:build unix

package superbench

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"testing"
)

// A harness that failed but said why in a failed result (Hermes on a model key
// the provider refused) has that result relayed, framed, and the worker still
// fails. Anything else a failed harness printed is dropped as before.
func TestRegisteredWorkerRelaysAFailedHarnessResultAndStillFails(t *testing.T) {
	failed := `{"version":"agentpod.superbench-worker.v2","binding":{"board_id":"brd_example1","card_id":"card_example1","run_id":"run_example1","epoch":1},"outcome":"failed","handoff":{"error":"Hermes stopped: the model provider answered HTTP 401 (unauthorized; check the model key)"}}`
	complete := `{"version":"agentpod.superbench-worker.v2","binding":{"board_id":"brd_example1","card_id":"card_example1","run_id":"run_example1","epoch":1},"outcome":"complete","handoff":{"summary":"done"}}`
	for name, printed := range map[string]string{"failed": failed, "complete": complete, "prose": "the model key was refused"} {
		t.Run(name, func(t *testing.T) {
			c := registeredTreeFixture(t)
			c.Task.Arguments = []string{"/bin/sh", "-c", `printf '%s' "$1"; exit 1`, "fixture", printed}
			raw, err := c.Bytes()
			if err != nil {
				t.Fatal(err)
			}
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.CommandContext(t.Context(), exe, "-test.run=^TestRegisteredWorkerSubprocess$")
			cmd.Dir = c.Task.WorkspaceRoot
			cmd.Env = []string{"REGISTERED_WORKER_TEST_CHILD=1", "REGISTERED_WORKER_DIGEST=" + groupedSHA(raw)}
			cmd.Stdin = bytes.NewReader(frameCapsule(raw))
			var out, logs bytes.Buffer
			cmd.Stdout, cmd.Stderr = &out, &logs
			var exit *exec.ExitError
			if err = cmd.Run(); !errors.As(err, &exit) || exit.ExitCode() != 1 || logs.String() != ErrRegisteredTask.Error()+"\n" {
				t.Fatalf("a failed harness must fail the worker: %v %q", err, logs.String())
			}
			if name != "failed" {
				if out.Len() != 0 {
					t.Fatalf("a failed harness's %s output was relayed: %q", name, out.Bytes())
				}
				return
			}
			got, err := ParseRegisteredResult(out.Bytes(), c.Task.Binding)
			if err != nil || got.Outcome != "failed" || got.Handoff["error"] == "" {
				t.Fatalf("the failed result was not relayed: %v %q", err, out.Bytes())
			}
		})
	}
}
