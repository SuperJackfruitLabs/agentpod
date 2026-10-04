// Package acptrace puts node-agent into the trace between the hub and a harness.
//
// The hub writes ACP JSON-RPC and node-agent forwards the bytes to the harness's stdin.
// For `session/new` and `session/prompt` carrying `params._meta.traceparent` (superwitness
// C2), node-agent records a forward span as that trace's child and hands the harness its own
// span id, so harness spans nest under the node. Anything it cannot read whole goes through
// byte for byte, and content is never read into a span.
package acptrace

import (
	"bytes"
	"context"
	"encoding/json"

	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/trace"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/telemetry"
)

var targets = map[string]bool{"session/new": true, "session/prompt": true}

func Rewrite(frame []byte, nodeSessionID string) (out []byte) {
	// A node never fails a request because of telemetry: anything unexpected passes the frame through.
	defer func() {
		if recover() != nil {
			out = frame
		}
	}()
	if len(frame) == 0 || frame[len(frame)-1] != '\n' || !bytes.Contains(frame, []byte(`"_meta"`)) {
		return frame
	}
	var buf bytes.Buffer
	changed := false
	for _, ln := range bytes.SplitAfter(frame, []byte("\n")) {
		if len(ln) == 0 {
			continue
		}
		if nl, ok := rewriteLine(ln, nodeSessionID); ok {
			buf.Write(nl)
			changed = true
			continue
		}
		buf.Write(ln)
	}
	if !changed {
		return frame
	}
	return buf.Bytes()
}

func rewriteLine(ln []byte, nodeSessionID string) ([]byte, bool) {
	var msg map[string]json.RawMessage
	if err := json.Unmarshal(ln, &msg); err != nil {
		return nil, false
	}
	var method string
	if err := json.Unmarshal(msg["method"], &method); err != nil || !targets[method] {
		return nil, false
	}
	var params map[string]json.RawMessage
	if err := json.Unmarshal(msg["params"], &params); err != nil || params == nil {
		return nil, false
	}
	var meta map[string]json.RawMessage
	if err := json.Unmarshal(params["_meta"], &meta); err != nil || meta == nil {
		return nil, false
	}
	var in telemetry.TraceMeta
	_ = json.Unmarshal(meta["traceparent"], &in.Traceparent)
	_ = json.Unmarshal(meta["tracestate"], &in.Tracestate)
	parent := telemetry.Extract(context.Background(), &in)
	if !trace.SpanContextFromContext(parent).IsValid() {
		return nil, false
	}

	ctx, span := telemetry.Tracer().Start(parent, "acp.forward "+method,
		trace.WithSpanKind(trace.SpanKindProducer),
		trace.WithAttributes(
			attribute.String("rpc.system", "jsonrpc"),
			attribute.String("rpc.method", method),
			attribute.String("acp.node_session_id", nodeSessionID),
		))
	defer span.End()
	if !span.IsRecording() {
		return nil, false // telemetry off: the hub's own context goes through untouched
	}
	child := telemetry.Inject(ctx)
	if child == nil {
		return nil, false
	}

	var err error
	if meta["traceparent"], err = marshal(child.Traceparent); err != nil {
		return nil, false
	}
	if child.Tracestate != "" {
		if meta["tracestate"], err = marshal(child.Tracestate); err != nil {
			return nil, false
		}
	}
	if params["_meta"], err = marshal(meta); err != nil {
		return nil, false
	}
	if msg["params"], err = marshal(params); err != nil {
		return nil, false
	}
	b, err := marshal(msg)
	if err != nil {
		return nil, false
	}
	return append(b, '\n'), true
}

// marshal never HTML-escapes, so `<`, `>` and `&` in a prompt reach the harness as written.
func marshal(v any) (json.RawMessage, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}
