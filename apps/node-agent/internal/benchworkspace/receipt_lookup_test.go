package benchworkspace

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
)

// Proposed Treaty revision c745dc79eab4e22ad55db7141f16082d8d36d090.
func TestProposedReceiptLookupOwnerCases(t *testing.T) {
	raw, e := os.ReadFile("testdata/receipt-lookup/cases.json")
	if e != nil {
		t.Fatal(e)
	}
	if fmt.Sprintf("%x", sha256.Sum256(raw)) != "c3b6c498c384c251384e8a86067025d2267170bc886abf5ae4231e3dcce37414" {
		t.Fatal("owner corpus pin changed")
	}
	type sample struct {
		Name, Kind      string
		Body            json.RawMessage
		Request         ReceiptLookupRequest
		Status          int
		OriginalRequest *Request `json:"original_request"`
	}
	var corpus struct {
		Valid, Invalid []sample
		Lexical        []struct{ Name, Raw string }
	}
	if e = json.Unmarshal(raw, &corpus); e != nil {
		t.Fatal(e)
	}
	for _, group := range []struct {
		Cases []sample
		Valid bool
	}{{corpus.Valid, true}, {corpus.Invalid, false}} {
		for _, c := range group.Cases {
			t.Run(c.Name, func(t *testing.T) {
				var e error
				if c.Kind == "request" {
					_, e = ParseReceiptLookupRequest(c.Body)
				} else {
					_, e = ParseReceiptLookupResponse(c.Body, c.Status, c.Request)
				}
				if (e == nil) != group.Valid {
					t.Fatalf("owner case acceptance=%v expected=%v", e == nil, group.Valid)
				}
				if group.Valid && c.OriginalRequest != nil {
					target, e := NewReceiptLookupRequest(*c.OriginalRequest)
					if e != nil || target != c.Request {
						t.Fatal("source typed identity mismatch", e)
					}
					out, e := ParseReceiptLookupResponse(c.Body, c.Status, c.Request)
					if e != nil || !strings.HasPrefix(out.Result.ResponseBody, " \n") {
						t.Fatal("exact historical bytes lost", e)
					}
					original, e := ParseResponse([]byte(out.Result.ResponseBody), out.Result.HTTPStatus, *c.OriginalRequest)
					if e != nil || original.OK != (out.Result.HTTPStatus < 400) {
						t.Fatal("not real original reply", e)
					}
				}
			})
		}
	}
	for _, c := range corpus.Lexical {
		t.Run(c.Name, func(t *testing.T) {
			if _, e := ParseReceiptLookupRequest([]byte(c.Raw)); e == nil {
				t.Fatal("invalid lexical target accepted")
			}
		})
	}
}
func TestReceiptLookupTransportBoundsAndPrivateHistoricalData(t *testing.T) {
	target := ReceiptLookupRequest{Version: Version, Operation: "receipt_lookup", TargetRequestID: "r", TargetDigest: strings.Repeat("a", 64)}
	raw, _ := json.Marshal(target)
	exact := append(append([]byte(nil), raw...), bytes.Repeat([]byte(" "), MaxBody-len(raw))...)
	if _, e := ParseReceiptLookupRequest(exact); e != nil {
		t.Fatal(e)
	}
	if _, e := ParseReceiptLookupRequest(append(exact, ' ')); e == nil {
		t.Fatal("oversized request")
	}
	response := ReceiptLookupResponse{Version: Version, Operation: "receipt_lookup", OK: true, Result: &ReceiptLookupResult{TargetRequestID: target.TargetRequestID, TargetDigest: target.TargetDigest, State: "completed", HTTPStatus: 200, ResponseBody: strings.Repeat("x", MaxBody)}}
	raw, _ = json.Marshal(response)
	exact = append(raw, bytes.Repeat([]byte(" "), MaxReceiptLookupResponse-len(raw))...)
	if _, e := ParseReceiptLookupResponse(exact, 200, target); e != nil {
		t.Fatal(e)
	}
	if _, e := ParseReceiptLookupResponse(append(exact, ' '), 200, target); e == nil {
		t.Fatal("oversized envelope")
	}
	response.Result.ResponseBody += "x"
	if ValidateReceiptLookupResponse(response, 200, target) == nil {
		t.Fatal("oversized original receipt")
	}
	response.Result.ResponseBody = "雪" + strings.Repeat("x", MaxBody-2)
	if ValidateReceiptLookupResponse(response, 200, target) == nil {
		t.Fatal("used character count instead of UTF8 bytes")
	}
}
