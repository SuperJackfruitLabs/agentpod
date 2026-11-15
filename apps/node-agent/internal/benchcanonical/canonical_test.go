package benchcanonical

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestProposedOwnerCanonicalVectors(t *testing.T) {
	raw, e := os.ReadFile("testdata/canonical.json")
	if e != nil {
		t.Fatal(e)
	}
	var corpus struct {
		Cases []struct {
			Name              string
			Value             json.RawMessage
			Canonical, SHA256 string
		}
	}
	if e = json.Unmarshal(raw, &corpus); e != nil {
		t.Fatal(e)
	}
	var source struct{ Revision, Path, SHA256, Status string }
	pin, e := os.ReadFile("testdata/source.json")
	if e != nil || json.Unmarshal(pin, &source) != nil {
		t.Fatal("missing owner pin", e)
	}
	sum := sha256.Sum256(raw)
	if source.Revision != "d578c7e3ed0709cf7d6d38f7545edacab1691201" || source.Status != "proposal" || source.Path != "fixtures/superpipeline-run-checkpoint/canonical.json" || source.SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatal("owner corpus pin changed")
	}
	for _, c := range corpus.Cases {
		t.Run(c.Name, func(t *testing.T) {
			got, e := Canonical(c.Value)
			if e != nil || string(got) != c.Canonical {
				t.Fatalf("canonical mismatch: %s %v", got, e)
			}
			h, e := Digest(c.Value)
			if e != nil || h != c.SHA256 {
				t.Fatal("owner digest mismatch", h, e)
			}
		})
	}
}

func TestCanonicalRejectsNonCanonicalIdentities(t *testing.T) {
	for _, raw := range []string{`null`, `{"a":1,"a":2}`, `{"a":1,"\u0061":2}`, `1e1`, `1.0`, `-0`, `-1`, `01`, `9007199254740992`, `"\ud800"`, `"\udfff"`, `{"a":null}`, `{} {}`, strings.Repeat("[", 130) + "0" + strings.Repeat("]", 130), string([]byte{'"', 0xff, '"'})} {
		if got, e := Canonical([]byte(raw)); e == nil || len(got) != 0 {
			t.Fatalf("invalid identity accepted %q", raw)
		}
	}
	got, e := Canonical([]byte(" {\"z\":9007199254740991,\"a\":\"\\n雪😀\"} \n"))
	if e != nil || string(got) != `{"a":"\u000a\u96ea\ud83d\ude00","z":9007199254740991}` {
		t.Fatal(string(got), e)
	}
}

func TestReceiptNormalizationRemovesOnlyTwoPrivateResultFields(t *testing.T) {
	first := []byte(`{"version":"example","ok":true,"result":{"root_path":"/private/a","grant":{"lease_token":"private"},"workspace":{"checkpoint":"one","root_path":"retain-this-known-data"},"execution":{"id":"one"}}}`)
	other := bytes.ReplaceAll(bytes.ReplaceAll(first, []byte("/private/a"), []byte("/private/b")), []byte(`"private"`), []byte(`"different"`))
	a, e := ReceiptDigest(first)
	b, f := ReceiptDigest(other)
	if e != nil || f != nil || a != b {
		t.Fatal("normalization changed", e, f)
	}
	for _, changed := range [][]byte{bytes.ReplaceAll(first, []byte(`"one"`), []byte(`"two"`)), bytes.ReplaceAll(first, []byte("retain-this-known-data"), []byte("different-data"))} {
		h, e := ReceiptDigest(changed)
		if e != nil || h == a {
			t.Fatal("significant receipt data omitted", e)
		}
	}
	for _, raw := range []string{`{"ok":false,"result":{}}`, `{"ok":true}`, `{"ok":true,"result":[]}`} {
		if _, e := ReceiptDigest([]byte(raw)); e == nil {
			t.Fatal("not a success object accepted", raw)
		}
	}
}
