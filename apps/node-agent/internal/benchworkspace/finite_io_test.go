package benchworkspace

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"strings"
	"testing"
	"time"
)

// testdata/private-execution-io.json is copied unchanged from the treaty
// repository's fixtures/superbench-api/private-execution-io.json (496959a).
type finiteVectors struct {
	Request  json.RawMessage `json:"request"`
	Response struct {
		Status int             `json:"status"`
		Body   json.RawMessage `json:"body"`
	} `json:"response"`
	ObservationRequest  json.RawMessage `json:"observation_request"`
	ObservationResponse json.RawMessage `json:"observation_response"`
	Base64              []struct {
		Encoded string `json:"encoded"`
		Hex     string `json:"hex"`
	} `json:"base64"`
	InvalidBase64   []string `json:"invalid_base64"`
	InvalidRequests []struct {
		Name string          `json:"name"`
		Body json.RawMessage `json:"body"`
	} `json:"invalid_requests"`
	RequestDigests []struct {
		Name      string          `json:"name"`
		Body      json.RawMessage `json:"body"`
		Canonical string          `json:"canonical"`
		SHA256    string          `json:"sha256"`
	} `json:"request_digests"`
	ObservationErrors []struct {
		Code     string `json:"code"`
		Statuses []int  `json:"statuses"`
	} `json:"observation_errors"`
	Capacity struct {
		Status int             `json:"status"`
		Body   json.RawMessage `json:"body"`
	} `json:"capacity_response"`
}

func loadFinite(t *testing.T) finiteVectors {
	t.Helper()
	raw, err := os.ReadFile("testdata/private-execution-io.json")
	if err != nil {
		t.Fatal(err)
	}
	var v finiteVectors
	if err = json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	for _, field := range []*json.RawMessage{&v.Response.Body, &v.ObservationResponse, &v.Capacity.Body} {
		var compact bytes.Buffer
		if err = json.Compact(&compact, *field); err != nil {
			t.Fatal(err)
		}
		*field = compact.Bytes()
	}
	return v
}

func TestFiniteRunMatchesTreatyDigests(t *testing.T) {
	v := loadFinite(t)
	for _, c := range v.RequestDigests {
		parsed, err := ParseFiniteRun([]byte(c.Canonical))
		if err != nil {
			t.Fatal(c.Name, err)
		}
		raw, _ := parsed.Bytes()
		digest, err := parsed.Digest()
		if err != nil || string(raw) != c.Canonical || digest != c.SHA256 {
			t.Fatal(c.Name, "digest drifted", digest)
		}
		stdin, _ := parsed.IO.Stdin()
		rebuilt, err := NewFiniteRun(parsed.Request, stdin, parsed.IO.StdoutLimitBytes)
		if err != nil {
			t.Fatal(err)
		}
		if again, _ := rebuilt.Digest(); again != c.SHA256 {
			t.Fatal(c.Name, "constructor drifted")
		}
	}
}

func TestFiniteRunRefusesTreatyInvalidRequests(t *testing.T) {
	v := loadFinite(t)
	for _, c := range v.InvalidRequests {
		if _, err := ParseFiniteRun(c.Body); err == nil {
			t.Fatal(c.Name, "accepted")
		}
	}
	plain := []byte(`{"version":"superbench.v2","operation":"lease","key":"card","holder":"run:one","request_id":"run-1","io":{"version":"superbench.finite-io.v1","stdin_base64":"","stdout_limit_bytes":1}}`)
	if _, err := ParseFiniteRun(plain); err == nil {
		t.Fatal("io accepted on a non-run operation")
	}
}

func TestFiniteBase64IsCanonical(t *testing.T) {
	v := loadFinite(t)
	for _, c := range v.Base64 {
		raw, ok := canonicalBase64(c.Encoded)
		if !ok || hex.EncodeToString(raw) != c.Hex {
			t.Fatal("valid base64 refused", c.Encoded)
		}
	}
	for _, c := range v.InvalidBase64 {
		if _, ok := canonicalBase64(c); ok {
			t.Fatal("noncanonical base64 accepted", c)
		}
	}
}

func treatyRun(t *testing.T, v finiteVectors) FiniteRunRequest {
	t.Helper()
	f, err := ParseFiniteRun(mustCanonicalRun(t, v.Request))
	if err != nil {
		t.Fatal(err)
	}
	return f
}

// mustCanonicalRun re-encodes the fixture request in the producer's field order.
func mustCanonicalRun(t *testing.T, raw json.RawMessage) []byte {
	t.Helper()
	var f struct {
		Request
		IO *FiniteInput `json:"io"`
	}
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	out, err := json.Marshal(FiniteRunRequest{Request: f.Request, IO: f.IO})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func TestFiniteResponseCarriesExactStdout(t *testing.T) {
	v := loadFinite(t)
	request := treatyRun(t, v)
	response, err := ParseFiniteResponse(v.Response.Body, v.Response.Status, request)
	if err != nil {
		t.Fatal(err)
	}
	outcome, ok := response.Result.(*FiniteRunOutcome)
	if !ok || outcome.IO == nil || *outcome.ExitCode != 7 {
		t.Fatal("finite outcome lost")
	}
	stdout, err := outcome.IO.Stdout(*request.IO)
	if err != nil || hex.EncodeToString(stdout) != "000102" {
		t.Fatal("stdout not exact", err)
	}
	// Ordinary parsing never accepts the profiled result.
	if _, err = ParseResponse(v.Response.Body, v.Response.Status, request.Request); err == nil {
		t.Fatal("unprofiled parser accepted io")
	}
	tampered := strings.Replace(string(v.Response.Body), `"stdout_bytes":3`, `"stdout_bytes":2`, 1)
	if _, err = ParseFiniteResponse([]byte(tampered), v.Response.Status, request); err == nil {
		t.Fatal("count mismatch accepted")
	}
	small := request
	io := *request.IO
	io.StdoutLimitBytes = 2
	small.IO = &io
	if _, err = ParseFiniteResponse(v.Response.Body, v.Response.Status, small); err == nil {
		t.Fatal("stdout above the requested limit accepted")
	}
	capacity, err := ParseFiniteResponse(v.Capacity.Body, v.Capacity.Status, request)
	if err != nil || capacity.Error == nil || capacity.Error.Code != "capacity_exhausted" {
		t.Fatal("capacity refusal not parsed", err)
	}
}

func TestFiniteSuccessRequiresIO(t *testing.T) {
	v := loadFinite(t)
	request := treatyRun(t, v)
	var body map[string]any
	_ = json.Unmarshal(v.Response.Body, &body)
	result := body["result"].(map[string]any)
	workspace := result["workspace"].(map[string]any)
	delete(workspace, "lease")
	workspace["ready_for_acquisition"] = true
	result["exit_code"] = 0
	body["ok"] = true
	delete(body, "error")
	ok, _ := json.Marshal(body)
	if _, err := ParseFiniteResponse(ok, 200, request); err != nil {
		t.Fatal("successful finite response refused", err)
	}
	delete(result, "io")
	missing, _ := json.Marshal(body)
	if _, err := ParseFiniteResponse(missing, 200, request); err == nil {
		t.Fatal("success without io accepted")
	}
}

func TestRegistrationObservationMatchesTreaty(t *testing.T) {
	v := loadFinite(t)
	var request RegistrationObserveRequest
	if err := json.Unmarshal(v.ObservationRequest, &request); err != nil {
		t.Fatal(err)
	}
	r, err := ParseRegistrationObserveResponse(v.ObservationResponse, 200, request)
	if err != nil || r.Result.RootPath != "/workspace/benches/card" || len(r.Result.Members) != 2 {
		t.Fatal("observation refused", err)
	}
	foreign := request
	foreign.BenchID = strings.Repeat("9", 32)
	if _, err = ParseRegistrationObserveResponse(v.ObservationResponse, 200, foreign); err == nil {
		t.Fatal("foreign bench accepted")
	}
	duplicate := strings.Replace(string(v.ObservationResponse), `"inode":"11"`, `"inode":"10"`, 1)
	if _, err = ParseRegistrationObserveResponse([]byte(duplicate), 200, request); err == nil {
		t.Fatal("duplicate node accepted")
	}
	for _, e := range v.ObservationErrors {
		for _, status := range e.Statuses {
			body := []byte(`{"version":"superbench.v2","operation":"registration_observe","ok":false,"error":{"code":"` + e.Code + `","message":"refused"}}`)
			if _, err = ParseRegistrationObserveResponse(body, status, request); err != nil {
				t.Fatal("treaty error refused", e.Code, status)
			}
		}
	}
}

func TestFiniteReceiptLookupAllowsLargerOriginal(t *testing.T) {
	v := loadFinite(t)
	lookup, _, err := FiniteTarget(treatyRun(t, v))
	if err != nil {
		t.Fatal(err)
	}
	original := strings.Repeat("a", MaxBody+1)
	body, _ := json.Marshal(ReceiptLookupResponse{Version: Version, Operation: "receipt_lookup", OK: true, Result: &ReceiptLookupResult{TargetRequestID: lookup.TargetRequestID, TargetDigest: lookup.TargetDigest, State: "completed", HTTPStatus: 200, ResponseBody: original}})
	if _, err = ParseReceiptLookupResponse(body, 200, lookup); err == nil {
		t.Fatal("unprofiled lookup accepted a profiled-size body")
	}
	if _, err = ParseFiniteReceiptLookupResponse(body, 200, lookup); err != nil {
		t.Fatal("profiled lookup refused", err)
	}
}

func TestPostSendsOnceWithTheProfile(t *testing.T) {
	calls := 0
	path := socketServer(t, func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Content-Type") != FiniteContentType || r.URL.Path != PathOperations {
			w.WriteHeader(500)
			return
		}
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("lost"))
	})
	client, err := NewClient(path, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	if _, _, err = client.Post(context.Background(), PathOperations, FiniteContentType, []byte("{}"), MaxFiniteBody); !errors.Is(err, ErrLost) || calls != 1 {
		t.Fatal("non-JSON reply was not reported lost exactly once", err, calls)
	}
	if _, _, err = client.Post(context.Background(), "/v1/run", FiniteContentType, []byte("{}"), 10); !errors.Is(err, ErrInvalid) || calls != 1 {
		t.Fatal("unknown path was sent")
	}
}
