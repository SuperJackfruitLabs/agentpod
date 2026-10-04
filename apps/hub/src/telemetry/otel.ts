/**
 * The hub's OpenTelemetry, by hand. Bun breaks Node auto-instrumentation (bun#26536),
 * so nothing here patches modules.
 *
 * Only `@opentelemetry/api` and the context manager load at import. The SDK and exporters
 * load inside `initTelemetry`, which runs only from `src/index.ts` and only when an
 * endpoint is configured. A hub without `OTEL_EXPORTER_OTLP_ENDPOINT` never loads them,
 * and neither does a test that does not ask for them (#457).
 *
 * The providers live in this module, not in the OTel globals. Globals can be set once per
 * process, and `bun test` runs every file in one process.
 */
import {
  context,
  metrics,
  trace,
  type Counter,
  type Histogram,
  type Meter,
  type MeterProvider,
  type Tracer,
  type TracerProvider,
} from "@opentelemetry/api";
import type { Logger as OtelLogger, LoggerProvider } from "@opentelemetry/api-logs";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";

export const SERVICE_NAME = "agentpod-hub";
const SCOPE = "agentpod-hub";

export interface TelemetryConfig {
  /** OTLP/HTTP base URL, e.g. http://127.0.0.1:4318. Null means telemetry is off. */
  endpoint: string | null;
  serviceVersion: string;
  environment: string;
  maxQueueSize: number;
  exportTimeoutMs: number;
  logs: boolean;
}

const intOr = (raw: string | undefined, fallback: number): number => {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function readTelemetryConfig(env: Record<string, string | undefined> = process.env): TelemetryConfig {
  const raw = (env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "").trim().replace(/\/+$/, "");
  const disabled = (env.OTEL_SDK_DISABLED ?? "").trim().toLowerCase() === "true";
  return {
    endpoint: raw && !disabled ? raw : null,
    serviceVersion: (env.AGENTPOD_VERSION ?? "").trim() || "dev",
    environment: (env.NODE_ENV ?? "").trim() || "development",
    maxQueueSize: intOr(env.OTEL_BSP_MAX_QUEUE_SIZE, 2048),
    exportTimeoutMs: intOr(env.OTEL_EXPORTER_OTLP_TIMEOUT, 10_000),
    logs: (env.OTEL_LOGS_EXPORTER ?? "otlp").trim().toLowerCase() !== "none",
  };
}

interface State {
  tracerProvider: TracerProvider;
  meterProvider: MeterProvider;
  loggerProvider: LoggerProvider | null;
}

const noopState = (): State => ({
  tracerProvider: trace.getTracerProvider(),
  meterProvider: metrics.getMeterProvider(),
  loggerProvider: null,
});

const state: State = noopState();

let contextReady = false;

/** The context manager is process-global and settable once. Idempotent. */
export function ensureContextManager(): void {
  if (contextReady) return;
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  contextReady = true;
}

export const tracer = (): Tracer => state.tracerProvider.getTracer(SCOPE);
export const meter = (): Meter => state.meterProvider.getMeter(SCOPE);
export const otelLogger = (): OtelLogger | null => state.loggerProvider?.getLogger(SCOPE) ?? null;

let cached: { provider: MeterProvider; dispatches: Counter; httpDuration: Histogram } | null = null;

/** Instruments with fixed, low-cardinality dimensions only. No ids, ever. */
export function instruments(): { dispatches: Counter; httpDuration: Histogram } {
  if (cached?.provider !== state.meterProvider) {
    const m = meter();
    cached = {
      provider: state.meterProvider,
      dispatches: m.createCounter("bridge.dispatches", { description: "Claimed runs, by outcome", unit: "{dispatch}" }),
      httpDuration: m.createHistogram("http.server.request.duration", {
        description: "Duration of HTTP server requests",
        unit: "s",
      }),
    };
  }
  return cached;
}

export interface TelemetryHandle {
  shutdown(timeoutMs?: number): Promise<void>;
}

let active: TelemetryHandle | null = null;

/**
 * Starts exporting when an endpoint is configured. Never throws: a malformed endpoint
 * (no scheme) or a failed SDK import must not stop the hub from booting. On failure it
 * warns on stdout, tears down whatever it half built, and returns null (telemetry off).
 */
export async function initTelemetry(cfg: TelemetryConfig): Promise<TelemetryHandle | null> {
  if (!cfg.endpoint) return null;
  if (active) return active;
  const partial: Array<{ shutdown(): Promise<void> }> = [];
  try {
    return await startTelemetry(cfg, partial);
  } catch (err) {
    resetTelemetry();
    active = null;
    for (const p of partial) {
      try {
        void p.shutdown().catch(() => undefined);
      } catch {
        // best effort
      }
    }
    // The error name only: the message of an exporter URL error quotes the endpoint.
    const kind = err instanceof Error ? err.name : "Error";
    console.log(`telemetry: disabled, could not start the exporters (${kind}); check OTEL_EXPORTER_OTLP_ENDPOINT includes a scheme, e.g. http://host:port`);
    return null;
  }
}

async function startTelemetry(
  cfg: TelemetryConfig,
  partial: Array<{ shutdown(): Promise<void> }>,
): Promise<TelemetryHandle> {
  ensureContextManager();

  const [
    { resourceFromAttributes },
    { BasicTracerProvider },
    { OTLPTraceExporter },
    { MeterProvider: SdkMeterProvider, PeriodicExportingMetricReader },
    { OTLPMetricExporter },
    { LoggerProvider: SdkLoggerProvider, BatchLogRecordProcessor },
    { OTLPLogExporter },
    { DroppingSpanProcessor },
  ] = await Promise.all([
    import("@opentelemetry/resources"),
    import("@opentelemetry/sdk-trace-base"),
    import("@opentelemetry/exporter-trace-otlp-http"),
    import("@opentelemetry/sdk-metrics"),
    import("@opentelemetry/exporter-metrics-otlp-http"),
    import("@opentelemetry/sdk-logs"),
    import("@opentelemetry/exporter-logs-otlp-http"),
    import("./bounded-processor"),
  ]);

  const resource = resourceFromAttributes({
    "service.name": SERVICE_NAME,
    "service.version": cfg.serviceVersion,
    "deployment.environment.name": cfg.environment,
  });

  const meterProvider = new SdkMeterProvider({
    resource,
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${cfg.endpoint}/v1/metrics`, timeoutMillis: cfg.exportTimeoutMs }),
        exportIntervalMillis: 60_000,
        exportTimeoutMillis: cfg.exportTimeoutMs,
      }),
    ],
  });
  partial.push(meterProvider);
  const dropped = meterProvider.getMeter(SCOPE).createCounter("otel.spans.dropped", {
    description: "Spans dropped because the export queue was full",
    unit: "{span}",
  });

  const tracerProvider = new BasicTracerProvider({
    resource,
    spanProcessors: [
      new DroppingSpanProcessor(
        new OTLPTraceExporter({ url: `${cfg.endpoint}/v1/traces`, timeoutMillis: cfg.exportTimeoutMs }),
        { maxQueueSize: cfg.maxQueueSize, onDrop: (n) => dropped.add(n), exportTimeoutMillis: cfg.exportTimeoutMs },
      ),
    ],
  });

  partial.push(tracerProvider);

  const loggerProvider = cfg.logs
    ? new SdkLoggerProvider({
        resource,
        processors: [
          // sdk-logs 0.222 takes the exporter inside the options object.
          new BatchLogRecordProcessor({
            exporter: new OTLPLogExporter({ url: `${cfg.endpoint}/v1/logs`, timeoutMillis: cfg.exportTimeoutMs }),
            maxQueueSize: cfg.maxQueueSize,
            maxExportBatchSize: 512,
            scheduledDelayMillis: 2_000,
            exportTimeoutMillis: cfg.exportTimeoutMs,
          }),
        ],
      })
    : null;
  if (loggerProvider) partial.push(loggerProvider);

  state.tracerProvider = tracerProvider;
  state.meterProvider = meterProvider;
  state.loggerProvider = loggerProvider;

  let done: Promise<void> | null = null;
  const handle: TelemetryHandle = {
    shutdown(timeoutMs = 3_000) {
      done ??= (async () => {
        // Nothing may reject out of here: a provider that rejects because the collector is
        // down would otherwise surface as an unhandled rejection and exit the process (ws1).
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const deadline = new Promise<void>((resolve) => {
            timer = setTimeout(resolve, timeoutMs);
          });
          const all = Promise.allSettled([
            tracerProvider.shutdown(),
            meterProvider.shutdown(),
            loggerProvider?.shutdown() ?? Promise.resolve(),
          ]).then(() => undefined);
          await Promise.race([all, deadline]);
        } catch {
          // A synchronous throw from a provider's shutdown is still just a failed flush.
        } finally {
          clearTimeout(timer);
          resetTelemetry();
          active = null;
        }
      })();
      return done;
    },
  };
  active = handle;
  return handle;
}

/** Flush and stop whatever `initTelemetry` started. Safe to call when nothing did. */
export async function shutdownTelemetry(timeoutMs = 3_000): Promise<void> {
  await active?.shutdown(timeoutMs);
}

/** Back to no-op providers. */
export function resetTelemetry(): void {
  Object.assign(state, noopState());
}

export function _setProvidersForTest(p: { tracerProvider?: TracerProvider; loggerProvider?: LoggerProvider | null }): void {
  if (p.tracerProvider) state.tracerProvider = p.tracerProvider;
  if (p.loggerProvider !== undefined) state.loggerProvider = p.loggerProvider;
}
