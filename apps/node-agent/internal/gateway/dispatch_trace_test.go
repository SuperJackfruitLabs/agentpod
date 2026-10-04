package gateway

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"go.opentelemetry.io/otel/trace"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/telemetry/telemetrytest"
)

func TestDispatchContinuesTheHubTraceFromMeta(t *testing.T) {
	sr := telemetrytest.UseRecorder(t)
	const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
	done := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, _ := websocket.Accept(w, r, nil)
		defer c.Close(websocket.StatusNormalClosure, "")
		ctx := context.Background()
		c.Write(ctx, websocket.MessageText, []byte(`{"type":"req","id":"1","verb":"ping","params":{},"_meta":{"traceparent":"`+tp+`"}}`))
		c.Read(ctx)
		c.Write(ctx, websocket.MessageText, []byte(`{"type":"req","id":"2","verb":"plain","params":{}}`))
		c.Read(ctx)
		close(done)
	}))
	defer srv.Close()

	var sawParent trace.SpanContext
	c, _, _ := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	go serve(context.Background(), c, HandlerFunc(func(ctx context.Context, verb string, _ json.RawMessage, _ func(int, string, bool, string) error) (any, bool, error) {
		if verb == "ping" {
			sawParent = trace.SpanContextFromContext(ctx)
		}
		return map[string]bool{"ok": true}, false, nil
	}))

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatal("no responses")
	}

	ended := sr.Ended()
	if len(ended) != 1 {
		t.Fatalf("want exactly one span (the req without _meta gets none), got %d", len(ended))
	}
	s := ended[0]
	if s.Name() != "ping" || s.SpanKind() != trace.SpanKindServer {
		t.Fatalf("span %q kind %v", s.Name(), s.SpanKind())
	}
	if s.Parent().SpanID().String() != "b7ad6b7169203331" || s.SpanContext().TraceID().String() != "0af7651916cd43dd8448eb211c80319c" {
		t.Fatalf("parent %v trace %v", s.Parent().SpanID(), s.SpanContext().TraceID())
	}
	if sawParent.SpanID() != s.SpanContext().SpanID() {
		t.Fatal("the handler must run under the verb span")
	}
}
