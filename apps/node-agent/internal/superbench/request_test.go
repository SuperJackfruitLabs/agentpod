package superbench

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCanonicalRequestVectors(t *testing.T) {
	raw, e := os.ReadFile("testdata/operations.json")
	if e != nil {
		t.Fatal(e)
	}
	var vectors struct {
		Valid   map[string]json.RawMessage `json:"valid"`
		Invalid []struct {
			Name string          `json:"name"`
			Body json.RawMessage `json:"body"`
		} `json:"invalid"`
		Decode []struct{ Name, Raw string } `json:"decode_rejections"`
	}
	if e = json.Unmarshal(raw, &vectors); e != nil {
		t.Fatal(e)
	}
	for name, body := range vectors.Valid {
		t.Run(name, func(t *testing.T) {
			if _, e := Parse(body); e != nil {
				t.Fatal(e)
			}
		})
	}
	for _, item := range vectors.Invalid {
		t.Run(item.Name, func(t *testing.T) {
			if _, e := Parse(item.Body); e == nil {
				t.Fatal("invalid canonical vector accepted")
			}
		})
	}
	for _, item := range vectors.Decode {
		t.Run(item.Name, func(t *testing.T) {
			if _, e := Parse([]byte(item.Raw)); e == nil {
				t.Fatal("lexically invalid request accepted")
			}
		})
	}
}
func TestPinnedContractHashes(t *testing.T) {
	raw, e := os.ReadFile("testdata/source.json")
	if e != nil {
		t.Fatal(e)
	}
	var manifest struct {
		Revision string
		Files    map[string]struct{ Local, SHA256 string }
	}
	if e = json.Unmarshal(raw, &manifest); e != nil {
		t.Fatal(e)
	}
	if len(manifest.Revision) != 40 {
		t.Fatal("missing source revision")
	}
	for _, item := range manifest.Files {
		raw, e := os.ReadFile(filepath.Join("testdata", item.Local))
		if e != nil {
			t.Fatal(e)
		}
		sum := sha256.Sum256(raw)
		if hex.EncodeToString(sum[:]) != item.SHA256 {
			t.Fatal("pinned treaty data changed without sync")
		}
	}
}
func TestInvalidUTF8AndOversizedRequests(t *testing.T) {
	for _, raw := range [][]byte{append([]byte(`{"version":"superbench.v1","operation":"status","key":"`), 0xff), make([]byte, MaxBody+1)} {
		if _, e := Parse(raw); e == nil {
			t.Fatal("transport-invalid payload accepted")
		}
	}
}

func TestArgumentItemsAreStrings(t *testing.T) {
	for _, raw := range []string{`{"version":"superbench.v1","operation":"run","key":"k","holder":"h","request_id":"r","arguments":["sh",null]}`, `{"version":"superbench.v1","operation":"run","key":"k","holder":"h","request_id":"r","arguments":["sh",2]}`} {
		if _, e := Parse([]byte(raw)); e == nil {
			t.Fatal("non-string argument accepted")
		}
	}
	if _, e := Parse([]byte(`{"version":"superbench.v1","operation":"run","key":"k","holder":"h","request_id":"r","arguments":["sh",""]}`)); e != nil {
		t.Fatal(e)
	}
}

func TestPinnedProducerParser(t *testing.T) {
	raw, e := os.ReadFile("testdata/producer.json")
	if e != nil {
		t.Fatal(e)
	}
	var source struct{ Revision, Path, SHA256 string }
	if e = json.Unmarshal(raw, &source); e != nil {
		t.Fatal(e)
	}
	if len(source.Revision) != 40 || source.Path != "internal/protocol/request.go" || len(source.SHA256) != 64 {
		t.Fatal("missing producer provenance")
	}
	raw, e = os.ReadFile("request.go")
	if e != nil {
		t.Fatal(e)
	}
	raw = []byte(strings.ReplaceAll(strings.ReplaceAll(string(raw), "package superbench", "package protocol"), "// Package superbench consumes", "// Package protocol defines"))
	raw = []byte(strings.ReplaceAll(string(raw), "e = d.Decode(&extra); !errors.Is(e, io.EOF)", "e = d.Decode(&extra); e != io.EOF"))
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != source.SHA256 {
		t.Fatal("producer parser changed without source reconciliation")
	}
}
