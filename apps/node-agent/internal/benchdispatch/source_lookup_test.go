package benchdispatch

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func TestReservedSourceSpecReadsExactActiveAndBoundAttemptWithoutEffects(t *testing.T) {
	trial := sourceFixture(t, true)
	c, spec := trial.coordinator, trial.spec
	if e := c.Store.ReserveSource(t.Context(), spec, c.Current); e != nil {
		t.Fatal(e)
	}
	path := filepath.Join(c.Store.Root, digest([]byte(spec.BenchKey))+".json")
	for _, bind := range []bool{false, true} {
		if bind {
			if _, e := c.Prepare(t.Context(), spec, trial.task); e != nil {
				t.Fatal(e)
			}
		}
		before, e := os.ReadFile(path)
		if e != nil {
			t.Fatal(e)
		}
		got, e := c.Store.ReservedSourceSpec(t.Context(), spec.BenchKey, spec.Identity)
		if e != nil || !reflect.DeepEqual(got, spec) || !got.Create {
			t.Fatal("original spec lost", e)
		}
		got.Repositories[0].Base = "caller-mutated"
		got, e = c.Store.ReservedSourceSpec(t.Context(), spec.BenchKey, spec.Identity)
		if e != nil || !reflect.DeepEqual(got, spec) {
			t.Fatal("lookup alias changed evidence", e)
		}
		changed := spec.Identity
		changed.ControlGrantID += "changed"
		wrong, e := c.Store.ReservedSourceSpec(t.Context(), spec.BenchKey, changed)
		if !errors.Is(e, ErrOwner) || !reflect.DeepEqual(wrong, SourceSpec{}) {
			t.Fatal("partial identity accepted", e)
		}
		after, e := os.ReadFile(path)
		if e != nil || !bytes.Equal(before, after) {
			t.Fatal("lookup rewrote state", e)
		}
	}
	if trial.count("create") != 1 || trial.count("lease") != 1 || trial.count("checkpoint") != 1 || trial.count("run") != 0 {
		t.Fatal("lookup dispatched")
	}
	before, _ := os.ReadFile(path)
	var doc map[string]json.RawMessage
	if e := json.Unmarshal(before, &doc); e != nil {
		t.Fatal(e)
	}
	doc["version"] = json.RawMessage(`"future"`)
	bad, _ := json.Marshal(doc)
	if e := os.WriteFile(path, bad, 0600); e != nil {
		t.Fatal(e)
	}
	if _, e := c.Store.ReservedSourceSpec(t.Context(), spec.BenchKey, spec.Identity); !errors.Is(e, ErrInvalid) {
		t.Fatal("corrupt record accepted", e)
	}
}
