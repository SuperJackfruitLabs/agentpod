/**
 * A span processor that never lets telemetry block or grow without bound.
 *
 * The SDK's BatchSpanProcessor drops silently when full. This one owns the bound, so it
 * can count what it drops (`otel.spans.dropped`). It counts a span from `onEnd` until its
 * export settles, so a collector that hangs keeps the count up and new spans are dropped,
 * not queued. A hung export is released at its own deadline, so the queue recovers.
 */
import { TraceFlags, type Context } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";

class ReleasingExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanExporter,
    private readonly release: (n: number) => void,
    private readonly timeoutMs: number,
  ) {}

  export(spans: ReadableSpan[], done: (r: ExportResult) => void): void {
    let settled = false;
    const finish = (r: ExportResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      this.release(spans.length);
      done(r);
    };
    const timer = setTimeout(
      () => finish({ code: ExportResultCode.FAILED, error: new Error("span export timed out") }),
      this.timeoutMs,
    );
    try {
      this.inner.export(spans, finish);
    } catch (err) {
      finish({ code: ExportResultCode.FAILED, error: err as Error });
    }
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush?.() ?? Promise.resolve();
  }
}

export interface DroppingOptions {
  maxQueueSize: number;
  onDrop: (n: number) => void;
  exportTimeoutMillis?: number;
  scheduledDelayMillis?: number;
}

export class DroppingSpanProcessor implements SpanProcessor {
  private inflight = 0;
  private readonly inner: BatchSpanProcessor;

  constructor(exporter: SpanExporter, private readonly opts: DroppingOptions) {
    const timeout = opts.exportTimeoutMillis ?? 10_000;
    this.inner = new BatchSpanProcessor(
      new ReleasingExporter(exporter, (n) => (this.inflight = Math.max(0, this.inflight - n)), timeout),
      {
        maxQueueSize: opts.maxQueueSize,
        maxExportBatchSize: Math.min(512, opts.maxQueueSize),
        scheduledDelayMillis: opts.scheduledDelayMillis ?? 2_000,
        exportTimeoutMillis: timeout + 1_000,
      },
    );
  }

  /** Spans ended and not yet settled by the exporter. */
  get queued(): number {
    return this.inflight;
  }

  onStart(span: Span, ctx: Context): void {
    this.inner.onStart(span, ctx);
  }

  onEnd(span: ReadableSpan): void {
    if ((span.spanContext().traceFlags & TraceFlags.SAMPLED) === 0) return;
    if (this.inflight >= this.opts.maxQueueSize) {
      this.opts.onDrop(1);
      return;
    }
    this.inflight++;
    this.inner.onEnd(span);
  }

  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }

  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}
