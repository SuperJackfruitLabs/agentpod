package telemetry

import (
	"context"
	"sync/atomic"
	"time"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
)

// DroppingOptions bounds the export queue. OnDrop counts what overflow throws away.
type DroppingOptions struct {
	MaxQueueSize  int
	ExportTimeout time.Duration
	BatchTimeout  time.Duration
	OnDrop        func(n int64)
}

type releasingExporter struct {
	sdktrace.SpanExporter
	release func(n int64)
}

func (e releasingExporter) ExportSpans(ctx context.Context, spans []sdktrace.ReadOnlySpan) error {
	defer e.release(int64(len(spans)))
	return e.SpanExporter.ExportSpans(ctx, spans)
}

// DroppingProcessor never blocks a caller and never queues without bound. It counts a span
// from OnEnd until its export returns, so a hung collector fills the bound and later spans are
// dropped and counted rather than queued.
type DroppingProcessor struct {
	inner    sdktrace.SpanProcessor
	inflight atomic.Int64
	max      int64
	onDrop   func(int64)
}

func NewDroppingProcessor(exp sdktrace.SpanExporter, o DroppingOptions) *DroppingProcessor {
	if o.MaxQueueSize <= 0 {
		o.MaxQueueSize = 2048
	}
	if o.ExportTimeout <= 0 {
		o.ExportTimeout = 10 * time.Second
	}
	if o.BatchTimeout <= 0 {
		o.BatchTimeout = 2 * time.Second
	}
	if o.OnDrop == nil {
		o.OnDrop = func(int64) {}
	}
	p := &DroppingProcessor{max: int64(o.MaxQueueSize), onDrop: o.OnDrop}
	p.inner = sdktrace.NewBatchSpanProcessor(
		releasingExporter{SpanExporter: exp, release: func(n int64) { p.inflight.Add(-n) }},
		sdktrace.WithMaxQueueSize(o.MaxQueueSize),
		sdktrace.WithMaxExportBatchSize(min(512, o.MaxQueueSize)),
		sdktrace.WithBatchTimeout(o.BatchTimeout),
		sdktrace.WithExportTimeout(o.ExportTimeout),
	)
	return p
}

// Queued is the number of spans ended and not yet settled by the exporter.
func (p *DroppingProcessor) Queued() int64 { return p.inflight.Load() }

func (p *DroppingProcessor) OnStart(ctx context.Context, s sdktrace.ReadWriteSpan) {
	p.inner.OnStart(ctx, s)
}

func (p *DroppingProcessor) OnEnd(s sdktrace.ReadOnlySpan) {
	if !s.SpanContext().IsSampled() {
		return
	}
	if p.inflight.Add(1) > p.max {
		p.inflight.Add(-1)
		p.onDrop(1)
		return
	}
	p.inner.OnEnd(s)
}

func (p *DroppingProcessor) ForceFlush(ctx context.Context) error { return p.inner.ForceFlush(ctx) }
func (p *DroppingProcessor) Shutdown(ctx context.Context) error   { return p.inner.Shutdown(ctx) }
