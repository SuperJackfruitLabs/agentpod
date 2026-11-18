package benchworkspace

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func load(t *testing.T, name string, value any) {
	t.Helper()
	raw, err := os.ReadFile("testdata/" + name)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(raw, value); err != nil {
		t.Fatal(err)
	}
}

func TestContractFilesAreBytePinnedAndRemainProposed(t *testing.T) {
	var pin struct {
		Status string
		Files  map[string]struct{ Local, SHA256 string }
	}
	load(t, "source.json", &pin)
	if !strings.Contains(pin.Status, "PROPOSED") || len(pin.Files) != 7 {
		t.Fatal("proposal pin changed")
	}
	for name, file := range pin.Files {
		raw, err := os.ReadFile("testdata/" + file.Local)
		if err != nil {
			t.Fatal(err)
		}
		sum := sha256.Sum256(raw)
		if hex.EncodeToString(sum[:]) != file.SHA256 {
			t.Fatal("contract drift", name)
		}
	}
}

func TestAllProposedRequestCorpusCases(t *testing.T) {
	type item struct {
		Name string
		Body json.RawMessage
		Raw  string
	}
	var corpus struct{ Valid, Invalid, Lexical []item }
	load(t, "workspace-operations.json", &corpus)
	if len(corpus.Valid) == 0 || len(corpus.Invalid) == 0 || len(corpus.Lexical) == 0 {
		t.Fatal("incomplete corpus")
	}
	for _, c := range corpus.Valid {
		t.Run("valid/"+c.Name, func(t *testing.T) {
			r, err := Parse(c.Body)
			if err != nil {
				t.Fatal(err)
			}
			raw, err := json.Marshal(r)
			if err != nil {
				t.Fatal(err)
			}
			if _, err = Parse(raw); err != nil {
				t.Fatal("typed request lost wire meaning", err)
			}
		})
	}
	for _, group := range [][]item{corpus.Invalid, corpus.Lexical} {
		for _, c := range group {
			t.Run("refuse/"+c.Name, func(t *testing.T) {
				raw := c.Body
				if c.Raw != "" {
					raw = []byte(c.Raw)
				}
				if _, err := Parse(raw); err == nil {
					t.Fatal("invalid request accepted")
				}
			})
		}
	}
}

func TestResponseWireChecksNeverInventProducerAuthority(t *testing.T) {
	type item struct {
		Name, Validation, Raw string
		Status                int
		Body                  json.RawMessage
		Expected              struct {
			Operation, Key, Holder string
			RequestID              string `json:"request_id"`
			LeaseToken             string `json:"lease_token"`
			Checkpoint             *bool
		}
	}
	var corpus struct{ Valid, Invalid, Lexical []item }
	load(t, "workspace-responses.json", &corpus)
	request := func(c item) Request {
		return Request{Version: Version, Operation: c.Expected.Operation, Key: c.Expected.Key, Holder: c.Expected.Holder, RequestID: c.Expected.RequestID, LeaseToken: c.Expected.LeaseToken, Checkpoint: c.Expected.Checkpoint}
	}
	for _, c := range corpus.Valid {
		t.Run("valid/"+c.Name, func(t *testing.T) {
			if _, err := ParseResponse(c.Body, c.Status, request(c)); err != nil {
				t.Fatal(err)
			}
		})
	}
	producerOnly := 0
	for _, c := range corpus.Invalid {
		t.Run("invalid/"+c.Name, func(t *testing.T) {
			_, err := ParseResponse(c.Body, c.Status, request(c))
			if c.Validation == "producer" {
				producerOnly++
				if err != nil {
					t.Fatal("wire client inferred private fencing/ownership evidence", err)
				}
			} else if err == nil {
				t.Fatal("invalid wire response accepted")
			}
		})
	}
	if producerOnly == 0 {
		t.Fatal("producer boundary cases missing")
	}
	for _, c := range corpus.Lexical {
		t.Run("lexical/"+c.Name, func(t *testing.T) {
			if _, err := ParseResponse([]byte(c.Raw), 200, Request{Operation: "status"}); err == nil {
				t.Fatal("ambiguous response accepted")
			}
		})
	}
}
