// Package telemetrytest installs an in-memory span recorder for one test.
package telemetrytest

import (
	"testing"

	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/sdk/trace/tracetest"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/telemetry"
)

// UseRecorder records every span ended until the test finishes. Do not use it in a t.Parallel test.
func UseRecorder(t testing.TB) *tracetest.SpanRecorder {
	t.Helper()
	sr := tracetest.NewSpanRecorder()
	restore := telemetry.SetTracerProvider(sdktrace.NewTracerProvider(sdktrace.WithSpanProcessor(sr)))
	t.Cleanup(restore)
	return sr
}
