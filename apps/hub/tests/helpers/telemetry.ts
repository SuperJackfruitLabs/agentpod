/**
 * In-memory telemetry for one test file. Installs on beforeAll and uninstalls on afterAll,
 * so a file that does not call this sees the no-op tracer and sends no `traceparent`. That
 * matters because every hub test file runs in one process.
 */
import { afterAll, beforeAll, beforeEach } from "bun:test";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  InMemoryLogRecordExporter,
  LoggerProvider,
  SimpleLogRecordProcessor,
  type ReadableLogRecord,
} from "@opentelemetry/sdk-logs";
import { _setProvidersForTest, ensureContextManager, resetTelemetry } from "../../src/telemetry/otel";

export function useTestTelemetry() {
  const spanExporter = new InMemorySpanExporter();
  const logExporter = new InMemoryLogRecordExporter();
  const tracerProvider = new BasicTracerProvider({ spanProcessors: [new SimpleSpanProcessor(spanExporter)] });
  const loggerProvider = new LoggerProvider({ processors: [new SimpleLogRecordProcessor(logExporter)] });

  beforeAll(() => {
    ensureContextManager();
    _setProvidersForTest({ tracerProvider, loggerProvider });
  });
  beforeEach(() => {
    spanExporter.reset();
    logExporter.reset();
  });
  afterAll(async () => {
    resetTelemetry();
    await tracerProvider.shutdown();
    await loggerProvider.shutdown();
  });

  return {
    spans: (): ReadableSpan[] => spanExporter.getFinishedSpans(),
    named: (name: string): ReadableSpan[] => spanExporter.getFinishedSpans().filter((s) => s.name === name),
    logs: (): ReadableLogRecord[] => logExporter.getFinishedLogRecords(),
  };
}
