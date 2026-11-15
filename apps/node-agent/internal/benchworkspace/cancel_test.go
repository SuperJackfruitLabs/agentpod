package benchworkspace

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

func TestCancellationContractPins(t *testing.T) {
	var pin struct {
		Status string
		Files  map[string]struct{ Local, SHA256 string }
	}
	load(t, "cancellation-source.json", &pin)
	if !strings.Contains(pin.Status, "PROPOSED") || len(pin.Files) != 5 {
		t.Fatal("cancellation pin changed")
	}
	for name, p := range pin.Files {
		raw, err := os.ReadFile("testdata/" + p.Local)
		if err != nil {
			t.Fatal(err)
		}
		h := sha256.Sum256(raw)
		if hex.EncodeToString(h[:]) != p.SHA256 {
			t.Fatal("contract drift", name)
		}
	}
}

func TestProposedCancellationCorpus(t *testing.T) {
	type item struct {
		Name, Kind, Raw string
		Body, Request   json.RawMessage
		Status          int
	}
	// Producer-only cases intentionally remain wire-valid: bytes cannot prove a fence.
	var corpus struct {
		Valid, Invalid, Lexical []item
		ProducerOnly            []item `json:"producer_only"`
	}
	load(t, "cancellation.json", &corpus)
	if len(corpus.Valid) != 13 || len(corpus.Invalid) != 40 || len(corpus.Lexical) != 10 || len(corpus.ProducerOnly) != 1 {
		t.Fatal("incomplete cancellation corpus")
	}
	check := func(c item) error {
		raw := c.Body
		if c.Raw != "" {
			raw = []byte(c.Raw)
		}
		if c.Kind == "request" {
			_, err := ParseCancelRequest(raw)
			return err
		}
		request := CancelRequest{Version: Version, Operation: "cancel", TargetRequestID: "run-example", TargetDigest: strings.Repeat("a", 64)}
		if len(c.Request) > 0 {
			if err := json.Unmarshal(c.Request, &request); err != nil {
				return err
			}
		}
		status := c.Status
		if status == 0 {
			status = 200
		}
		_, err := ParseCancelResponse(raw, status, request)
		return err
	}
	for _, c := range append(corpus.Valid, corpus.ProducerOnly...) {
		t.Run("valid/"+c.Name, func(t *testing.T) {
			if err := check(c); err != nil {
				t.Fatal(err)
			}
		})
	}
	for _, c := range append(corpus.Invalid, corpus.Lexical...) {
		t.Run("refuse/"+c.Name, func(t *testing.T) {
			if check(c) == nil {
				t.Fatal("invalid cancellation accepted")
			}
		})
	}
}

func TestCancellationUsesActualTypedSourceDigest(t *testing.T) {
	var fixture struct {
		Vectors []struct{ Name, Wire, Canonical, SHA256 string }
	}
	load(t, "source-digests.json", &fixture)
	if len(fixture.Vectors) != 5 {
		t.Fatal("incomplete source vectors")
	}
	for _, v := range fixture.Vectors {
		t.Run(v.Name, func(t *testing.T) {
			request, err := Parse([]byte(v.Wire))
			if err != nil {
				t.Fatal(err)
			}
			canonical, err := json.Marshal(request)
			if err != nil || string(canonical) != v.Canonical {
				t.Fatal("typed canonical source changed")
			}
			target, err := NewCancelRequest(request)
			if err != nil {
				t.Fatal(err)
			}
			if target.TargetRequestID != request.RequestID || target.TargetDigest != v.SHA256 {
				t.Fatal("cancellation target changed")
			}
		})
	}
	if _, err := NewCancelRequest(Request{Version: Version, Operation: "status"}); err == nil {
		t.Fatal("read promoted to cancellation target")
	}
}

func TestCancellationRejectsInvalidUTF8AndRawByteOverflow(t *testing.T) {
	target := CancelRequest{Version: Version, Operation: "cancel", TargetRequestID: "run-example", TargetDigest: strings.Repeat("a", 64)}
	raw, err := json.Marshal(target)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := ParseCancelRequest(append(raw, []byte(strings.Repeat(" ", MaxBody))...)); err == nil {
		t.Fatal("oversized raw request accepted")
	}
	invalid := []byte(`{"version":"superbench.v2","operation":"cancel","ok":false,"error":{"code":"unavailable","message":"X"}}`)
	for i, b := range invalid {
		if b == 'X' {
			invalid[i] = 0xff
		}
	}
	if _, err := ParseCancelResponse(invalid, 503, target); err == nil {
		t.Fatal("invalid UTF8 error accepted")
	}
}
