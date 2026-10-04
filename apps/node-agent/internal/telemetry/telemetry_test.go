package telemetry

import (
	"context"
	"testing"
	"time"

	"go.opentelemetry.io/otel/trace"
)

func env(m map[string]string) func(string) string { return func(k string) string { return m[k] } }

func TestFromEnv(t *testing.T) {
	if got := FromEnv("v1", env(nil)).Endpoint; got != "" {
		t.Fatalf("unset endpoint: got %q", got)
	}
	if got := FromEnv("v1", env(map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "http://127.0.0.1:4318/"})).Endpoint; got != "http://127.0.0.1:4318" {
		t.Fatalf("trailing slash: got %q", got)
	}
	if got := FromEnv("v1", env(map[string]string{"OTEL_EXPORTER_OTLP_ENDPOINT": "http://x", "OTEL_SDK_DISABLED": "true"})).Endpoint; got != "" {
		t.Fatalf("OTEL_SDK_DISABLED: got %q", got)
	}
}

func TestSetupDisabledIsANoop(t *testing.T) {
	shutdown, err := Setup(context.Background(), Config{})
	if err != nil {
		t.Fatal(err)
	}
	_, span := Tracer().Start(context.Background(), "x")
	if span.IsRecording() {
		t.Fatal("span recording with telemetry off")
	}
	span.End()
	if err := shutdown(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestSetupNeverBlocksOnAnUnreachableCollector(t *testing.T) {
	shutdown, err := Setup(context.Background(), Config{Endpoint: "http://127.0.0.1:9", Version: "test", MaxQueueSize: 64})
	if err != nil {
		t.Fatal(err)
	}
	start := time.Now()
	for i := 0; i < 5000; i++ {
		_, s := Tracer().Start(context.Background(), "s")
		s.End()
	}
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("ending spans took %v", d)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	start = time.Now()
	_ = shutdown(ctx)
	if d := time.Since(start); d > 2*time.Second {
		t.Fatalf("shutdown took %v", d)
	}
}

func TestExtractInjectRoundTrip(t *testing.T) {
	const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01"
	ctx := Extract(context.Background(), &TraceMeta{Traceparent: tp})
	sc := trace.SpanContextFromContext(ctx)
	if !sc.IsValid() || sc.TraceID().String() != "0af7651916cd43dd8448eb211c80319c" {
		t.Fatalf("extract: %v", sc)
	}
	if got := Inject(ctx); got == nil || got.Traceparent != tp {
		t.Fatalf("inject: %+v", got)
	}
	if Extract(context.Background(), nil) != context.Background() {
		t.Fatal("nil meta must leave ctx alone")
	}
	if trace.SpanContextFromContext(Extract(context.Background(), &TraceMeta{Traceparent: "garbage"})).IsValid() {
		t.Fatal("garbage traceparent must not produce a span context")
	}
}
