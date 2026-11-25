package benchcoordinatorwire

import (
	"encoding/json"
	"errors"
	"os"
	"strings"
	"testing"
)

type sharedCorpus struct {
	BindingCanonical string `json:"binding_canonical"`
	BindingSHA256    string `json:"binding_sha256"`
	Requests         []struct {
		Name   string
		Value  json.RawMessage
		Accept bool
	}
	Responses []struct {
		Name    string
		Request json.RawMessage
		Value   json.RawMessage
		Accept  bool
	}
	Lexical []struct {
		Name string
		Raw  string
	}
}

func corpus(t *testing.T) sharedCorpus {
	t.Helper()
	var c sharedCorpus
	raw, e := os.ReadFile("../../../../packages/contract/src/fixtures/bench-coordinator-v1.json")
	if e != nil {
		t.Fatal(e)
	}
	if json.Unmarshal(raw, &c) != nil {
		t.Fatal("corpus invalid")
	}
	return c
}
func TestSharedCorpus(t *testing.T) {
	c := corpus(t)
	for _, v := range c.Requests {
		t.Run("request/"+v.Name, func(t *testing.T) {
			_, e := ParseRequest(v.Value)
			if (e == nil) != v.Accept {
				t.Fatalf("accept=%v error=%v", v.Accept, e)
			}
		})
	}
	for _, v := range c.Responses {
		t.Run("response/"+v.Name, func(t *testing.T) {
			r, e := ParseRequest(v.Request)
			if e != nil {
				t.Fatal(e)
			}
			_, e = ParseResponse(v.Value, r)
			if (e == nil) != v.Accept {
				t.Fatalf("accept=%v error=%v", v.Accept, e)
			}
		})
	}
	for _, v := range c.Lexical {
		t.Run("lexical/"+v.Name, func(t *testing.T) {
			if _, e := ParseRequest([]byte(v.Raw)); !refused(e) {
				t.Fatalf("not closed refusal: %v", e)
			}
		})
	}
	var b SourceBinding
	if decode([]byte(c.BindingCanonical), MaxResponse, &b) != nil {
		t.Fatal("binding invalid")
	}
	h, e := BindingDigest(b)
	if e != nil || h != c.BindingSHA256 {
		t.Fatalf("binding digest mismatch: %s %v", h, e)
	}
	raw, _ := json.Marshal(b)
	if string(raw) != c.BindingCanonical {
		t.Fatal("declared binding serialization changed")
	}
}
func TestUTF8SizeAndStrictInput(t *testing.T) {
	c := corpus(t)
	var r Request
	if json.Unmarshal(c.Requests[1].Value, &r) != nil {
		t.Fatal("fixture")
	}
	r.Task.Prompt = strings.Repeat("界", 23000)
	raw, _ := json.Marshal(r)
	if _, e := ParseRequest(raw); !refused(e) {
		t.Fatal("multibyte request accepted")
	}
	for _, raw := range [][]byte{make([]byte, MaxRequest+1), {0xff}, []byte(strings.Repeat("[", 66) + "0" + strings.Repeat("]", 66))} {
		if _, e := ParseRequest(raw); !refused(e) {
			t.Fatal("unsafe raw accepted")
		}
	}
}
func TestRequiredZeroFieldsAndUnknowns(t *testing.T) {
	c := corpus(t)
	var r map[string]any
	if json.Unmarshal(c.Requests[1].Value, &r) != nil {
		t.Fatal("fixture")
	}
	owner := r["identity"].(map[string]any)
	for _, key := range []string{"epoch", "control_grant_id", "policy_sha256"} {
		saved := owner[key]
		delete(owner, key)
		raw, _ := json.Marshal(r)
		if _, e := ParseRequest(raw); !refused(e) {
			t.Fatal("missing identity field")
		}
		owner[key] = saved
	}
	r["operation"] = "status"
	raw, _ := json.Marshal(r)
	if _, e := ParseRequest(raw); !refused(e) {
		t.Fatal("status with task")
	}
}
func TestWorkerTextSizeUsesSerializedUTF8(t *testing.T) {
	got, e := wireSize(map[string]string{"text": "<>&\u2028\u2029"})
	if e != nil || got != 20 {
		t.Fatalf("HTML/U+2028 size %d %v", got, e)
	}
}

func TestResponseLimitAndUnvalidatedRequest(t *testing.T) {
	c := corpus(t)
	sample := c.Responses[0]
	r, e := ParseRequest(sample.Request)
	if e != nil {
		t.Fatal(e)
	}
	raw := append(append([]byte(nil), sample.Value...), []byte(strings.Repeat(" ", MaxResponse))...)
	if _, e := ParseResponse(raw, r); !refused(e) {
		t.Fatal("response raw limit missing")
	}
	if _, e := ParseResponse(sample.Value, Request{Operation: "ready"}); !refused(e) {
		t.Fatal("invalid request correlation accepted")
	}
}
func TestEscapedScalarRoundTrip(t *testing.T) {
	c := corpus(t)
	var r Request
	if json.Unmarshal(c.Requests[1].Value, &r) != nil {
		t.Fatal("fixture")
	}
	r.Task.Prompt = "emoji 😀 <>&\u2028\u2029"
	raw, _ := json.Marshal(r)
	got, e := ParseRequest(raw)
	if e != nil || got.Task.Prompt != r.Task.Prompt {
		t.Fatal("valid Unicode scalar refused")
	}
}

func refused(err error) bool { return errors.Is(err, ErrInvalid) && err.Error() == ErrInvalid.Error() }

// TestAttachFinishFieldSets pins the remote operations' exact field sets: each
// named field is required, nothing else is admitted, and the public key is
// bounded at MaxPublicKey bytes.
func TestAttachFinishFieldSets(t *testing.T) {
	c := corpus(t)
	valid := map[string]json.RawMessage{}
	for _, v := range c.Requests {
		if v.Name == "attach" || v.Name == "finish" {
			valid[v.Name] = v.Value
		}
	}
	want := map[string][]string{
		"attach": {"version", "operation", "tenant_id", "board_id", "station_id", "identity", "target", "binding_sha256", "public_key"},
		"finish": {"version", "operation", "tenant_id", "board_id", "station_id", "identity", "target", "binding_sha256", "report"},
	}
	for op, names := range want {
		raw, ok := valid[op]
		if !ok {
			t.Fatal("corpus has no", op)
		}
		if _, e := ParseRequest(raw); e != nil {
			t.Fatal(op, e)
		}
		var m map[string]any
		if json.Unmarshal(raw, &m) != nil || len(m) != len(names) {
			t.Fatalf("%s fixture has %d fields, want %d", op, len(m), len(names))
		}
		for _, name := range names {
			saved := m[name]
			delete(m, name)
			out, _ := json.Marshal(m)
			if _, e := ParseRequest(out); !refused(e) {
				t.Fatalf("%s without %s accepted", op, name)
			}
			m[name] = saved
		}
		for _, extra := range []string{"lease_token", "task", "source_receipt", "unknown"} {
			m[extra] = "x"
			out, _ := json.Marshal(m)
			if _, e := ParseRequest(out); !refused(e) {
				t.Fatalf("%s with %s accepted", op, extra)
			}
			delete(m, extra)
		}
	}
	var attach map[string]any
	_ = json.Unmarshal(valid["attach"], &attach)
	for size, accept := range map[int]bool{MaxPublicKey: true, MaxPublicKey + 1: false} {
		attach["public_key"] = "ssh-ed25519 " + strings.Repeat("A", size-len("ssh-ed25519 "))
		out, _ := json.Marshal(attach)
		if _, e := ParseRequest(out); (e == nil) != accept {
			t.Fatalf("public key of %d bytes: accept=%v error=%v", size, accept, e)
		}
	}
	var finish map[string]any
	_ = json.Unmarshal(valid["finish"], &finish)
	report := finish["report"].(map[string]any)
	report["extra"] = "x"
	out, _ := json.Marshal(finish)
	if _, e := ParseRequest(out); !refused(e) {
		t.Fatal("report with an unknown field accepted")
	}
	delete(report, "extra")
	// An attached reply answers only an attach.
	r, _ := ParseRequest(valid["finish"])
	for _, v := range c.Responses {
		if v.Name == "attached" {
			if _, e := ParseResponse(v.Value, r); !refused(e) {
				t.Fatal("attached reply accepted for a finish")
			}
		}
	}
}
