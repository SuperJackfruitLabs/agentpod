package benchdispatch

import (
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestLegacyDocumentExactReplayAndReadOnlyInspection(t *testing.T) {
	s, p, _ := fixture(t)
	prepare(t, s, p)
	path := filepath.Join(s.Root, digest([]byte(p.BenchKey))+".json")
	before, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var doc state
	if err = json.Unmarshal(before, &doc); err != nil || doc.Version != version || len(doc.Records) != 1 || doc.Active != planID(p) {
		t.Fatal("legacy initial shape changed", err)
	}
	if _, err = s.Inspect(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	if err = s.Prepare(context.Background(), p); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("legacy replay or read rewrote document", err)
	}
}
