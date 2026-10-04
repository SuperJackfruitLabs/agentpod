package telemetry

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// hung is a collector that accepted the connection and went silent: it returns only when its ctx ends.
type hung struct{}

func (hung) ExportSpans(ctx context.Context, _ []sdktrace.ReadOnlySpan) error {
	<-ctx.Done()
	return ctx.Err()
}
func (hung) Shutdown(context.Context) error { return nil }

func TestDroppingProcessorBoundsAndCounts(t *testing.T) {
	var dropped atomic.Int64
	p := NewDroppingProcessor(hung{}, DroppingOptions{
		MaxQueueSize: 3, ExportTimeout: 50 * time.Millisecond, BatchTimeout: 10 * time.Millisecond,
		OnDrop: func(n int64) { dropped.Add(n) },
	})
	tr := sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(p)).Tracer("t")
	for i := 0; i < 5; i++ {
		_, s := tr.Start(context.Background(), "s")
		s.End()
	}
	if p.Queued() != 3 || dropped.Load() != 2 {
		t.Fatalf("queued=%d dropped=%d, want 3 and 2", p.Queued(), dropped.Load())
	}
	deadline := time.Now().Add(2 * time.Second)
	for p.Queued() != 0 {
		if time.Now().After(deadline) {
			t.Fatalf("queue never drained after export timeout: %d", p.Queued())
		}
		time.Sleep(10 * time.Millisecond)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	_ = p.Shutdown(ctx)
}
