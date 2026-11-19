package benchlaunch

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/benchdispatch"
)

// corpusStatusError answers a specific-key status with a named error case from
// the SuperBench response corpus (testdata copied from the contract's
// fixtures/superbench-api). The corpus states its errors on a lease; only the
// operation and request_id change.
func corpusStatusError(t *testing.T, name string) (int, []byte) {
	t.Helper()
	raw, err := os.ReadFile("../benchworkspace/testdata/workspace-responses.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus struct {
		Valid []struct {
			Name   string
			Status int
			Body   map[string]any
		}
	}
	if err = json.Unmarshal(raw, &corpus); err != nil {
		t.Fatal(err)
	}
	for _, c := range corpus.Valid {
		if c.Name == name {
			c.Body["operation"] = "status"
			delete(c.Body, "request_id")
			body, _ := json.Marshal(c.Body)
			return c.Status, body
		}
	}
	t.Fatal("corpus case missing", name)
	return 0, nil
}

// A card's first attempt on the registered launch: the bridge chose create
// because the key has no bench. The stuck-bench check before the create reads
// the key's status and gets not_found; that is absence, so the create goes out
// once and the attempt runs. Before this the not_found parked the prepare.
func TestNewKeyIsCreatedWhenStatusIsNotFound(t *testing.T) {
	tr := newTrial(t)
	tr.absent = true
	first := creating(tr.spec, "attempt-1")
	tr.spec = first
	tr.current.Store(&first)
	if _, err := tr.c.Prepare(context.Background(), first, tr.task); err != nil {
		t.Fatal("a new key was not created", err)
	}
	if tr.count(tr.posts, "status") == 0 || tr.count(tr.effects, "create") != 1 || tr.count(tr.effects, "lease") != 1 {
		t.Fatal("new key not created exactly once", tr.count(tr.posts, "status"), tr.count(tr.effects, "create"))
	}
	if _, err := tr.c.Execute(context.Background(), first, admitAll); err != nil {
		t.Fatal("the new bench did not run", err)
	}
}

// unavailable says nothing about the key: the prepare stays pending and sends
// no create until status answers.
func TestUnavailableStatusSendsNoCreate(t *testing.T) {
	tr := newTrial(t)
	tr.absent, tr.statusDown = true, true
	first := creating(tr.spec, "attempt-1")
	tr.spec = first
	tr.current.Store(&first)
	if _, err := tr.c.Prepare(context.Background(), first, tr.task); !errors.Is(err, benchdispatch.ErrPending) {
		t.Fatal("an unavailable status did not park the prepare", err)
	}
	if tr.count(tr.posts, "create") != 0 || tr.count(tr.posts, "lease") != 0 {
		t.Fatal("an unavailable status let a create out")
	}
	tr.statusDown = false
	if _, err := tr.c.Prepare(context.Background(), first, tr.task); err != nil || tr.count(tr.effects, "create") != 1 {
		t.Fatal("the retry did not create once status answered", err)
	}
}
