package acptrace

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/telemetry/telemetrytest"
)

const (
	marker = "CANARY-MARKER-g0n0de"
	tp     = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
)

func line(method string, meta string) []byte {
	return []byte(`{"jsonrpc":"2.0","id":3,"method":"` + method + `","params":{"sessionId":"s","prompt":[{"type":"text","text":"a <b> & ` + marker + `"}]` + meta + `}}` + "\n")
}

func TestRewriteParentsTheHarnessUnderAForwardSpan(t *testing.T) {
	sr := telemetrytest.UseRecorder(t)
	in := line("session/prompt", `,"_meta":{"traceparent":"`+tp+`"}`)
	out := Rewrite(in, "acp_node_1")

	var before, after map[string]any
	if err := json.Unmarshal(in, &before); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(out, &after); err != nil {
		t.Fatalf("output is not JSON: %s", out)
	}
	if !bytes.HasSuffix(out, []byte("\n")) {
		t.Fatal("newline framing lost")
	}
	bp, ap := before["params"].(map[string]any), after["params"].(map[string]any)
	if !reflect.DeepEqual(bp["prompt"], ap["prompt"]) || after["id"] != before["id"] || after["method"] != before["method"] {
		t.Fatalf("content changed:\n%s\n%s", in, out)
	}

	ended := sr.Ended()
	if len(ended) != 1 || ended[0].Name() != "acp.forward session/prompt" {
		t.Fatalf("spans: %v", ended)
	}
	s := ended[0]
	if s.Parent().SpanID().String() != "b7ad6b7169203331" {
		t.Fatalf("parent: %v", s.Parent().SpanID())
	}
	gotTP := ap["_meta"].(map[string]any)["traceparent"].(string)
	want := "00-" + s.SpanContext().TraceID().String() + "-" + s.SpanContext().SpanID().String() + "-01"
	if gotTP != want {
		t.Fatalf("traceparent %q, want %q", gotTP, want)
	}
	for _, kv := range s.Attributes() {
		if strings.Contains(kv.Value.Emit(), marker) {
			t.Fatalf("content leaked into attribute %s", kv.Key)
		}
	}
}

func TestRewriteLeavesEverythingElseByteForByte(t *testing.T) {
	telemetrytest.UseRecorder(t)
	cases := map[string][]byte{
		"partial frame":          []byte(`{"jsonrpc":"2.0","method":"session/prompt","params":{"_meta":{"traceparent":"` + tp + `"}`),
		"not json":               []byte("hello \"_meta\"\n"),
		"other method":           line("session/cancel", `,"_meta":{"traceparent":"`+tp+`"}`),
		"no _meta":               line("session/prompt", ""),
		"garbage traceparent":    line("session/prompt", `,"_meta":{"traceparent":"nope"}`),
		"a response, not a call": []byte(`{"jsonrpc":"2.0","id":1,"result":{"_meta":{}}}` + "\n"),
	}
	for name, in := range cases {
		if out := Rewrite(in, "n"); !bytes.Equal(out, in) {
			t.Errorf("%s: changed\n in: %s\nout: %s", name, in, out)
		}
	}
}

func TestRewriteHandlesTwoLinesInOneFrame(t *testing.T) {
	sr := telemetrytest.UseRecorder(t)
	in := append(line("session/new", `,"_meta":{"traceparent":"`+tp+`"}`), line("session/cancel", "")...)
	out := Rewrite(in, "n")
	if n := bytes.Count(out, []byte("\n")); n != 2 {
		t.Fatalf("want 2 lines, got %d: %s", n, out)
	}
	if !bytes.HasSuffix(out, line("session/cancel", "")) {
		t.Fatal("second line changed")
	}
	if len(sr.Ended()) != 1 {
		t.Fatalf("want 1 span, got %d", len(sr.Ended()))
	}
}

func TestRewriteIsAPassThroughWhenTelemetryIsOff(t *testing.T) {
	// No recorder installed: the global provider is the non-recording default.
	in := line("session/prompt", `,"_meta":{"traceparent":"`+tp+`"}`)
	want := append([]byte(nil), in...)
	out := Rewrite(in, "acp_node_1")
	if !bytes.Equal(out, want) {
		t.Fatalf("bytes changed:\n%s\n%s", want, out)
	}
	if &out[0] != &in[0] || len(out) != len(in) {
		t.Fatal("expected the very same slice back when telemetry is off")
	}
}
