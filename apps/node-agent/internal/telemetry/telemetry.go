// Package telemetry is node-agent's OpenTelemetry: OTLP/HTTP to the host collector when
// OTEL_EXPORTER_OTLP_ENDPOINT is set, nothing at all when it is not. The provider is held
// here, not in the otel globals, so tests can swap it and restore it.
package telemetry

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/exporters/otlp/otlpmetric/otlpmetrichttp"
	"go.opentelemetry.io/otel/exporters/otlp/otlptrace/otlptracehttp"
	"go.opentelemetry.io/otel/metric"
	"go.opentelemetry.io/otel/propagation"
	sdkmetric "go.opentelemetry.io/otel/sdk/metric"
	"go.opentelemetry.io/otel/sdk/resource"
	sdktrace "go.opentelemetry.io/otel/sdk/trace"
	"go.opentelemetry.io/otel/trace"
)

const (
	ServiceName = "agentpod-node-agent"
	scope       = "github.com/rakeshgangwar/agentpod/node-agent"
)

type Config struct {
	Endpoint     string
	Version      string
	MaxQueueSize int
}

func FromEnv(version string, getenv func(string) string) Config {
	ep := strings.TrimRight(strings.TrimSpace(getenv("OTEL_EXPORTER_OTLP_ENDPOINT")), "/")
	if strings.EqualFold(strings.TrimSpace(getenv("OTEL_SDK_DISABLED")), "true") {
		ep = ""
	}
	return Config{Endpoint: ep, Version: version, MaxQueueSize: 2048}
}

type tpBox struct{ tp trace.TracerProvider }

var current atomic.Value // tpBox

func provider() trace.TracerProvider {
	if b, ok := current.Load().(tpBox); ok {
		return b.tp
	}
	return otel.GetTracerProvider()
}

// SetTracerProvider installs tp and returns a func that puts the previous one back.
func SetTracerProvider(tp trace.TracerProvider) (restore func()) {
	prev := provider()
	current.Store(tpBox{tp})
	return func() { current.Store(tpBox{prev}) }
}

func Tracer() trace.Tracer { return provider().Tracer(scope) }

var w3c = propagation.TraceContext{}

// TraceMeta is the C2 `_meta` object on broker requests and ACP params.
type TraceMeta struct {
	Traceparent string `json:"traceparent"`
	Tracestate  string `json:"tracestate,omitempty"`
}

func Extract(ctx context.Context, m *TraceMeta) context.Context {
	if m == nil || m.Traceparent == "" {
		return ctx
	}
	c := propagation.MapCarrier{"traceparent": m.Traceparent}
	if m.Tracestate != "" {
		c["tracestate"] = m.Tracestate
	}
	return w3c.Extract(ctx, c)
}

func Inject(ctx context.Context) *TraceMeta {
	c := propagation.MapCarrier{}
	w3c.Inject(ctx, c)
	if c["traceparent"] == "" {
		return nil
	}
	return &TraceMeta{Traceparent: c["traceparent"], Tracestate: c["tracestate"]}
}

func hostname() string {
	h, _ := os.Hostname()
	return h
}

// Setup installs exporting providers when cfg.Endpoint is set. Off, it changes nothing and
// returns a shutdown that does nothing.
func Setup(ctx context.Context, cfg Config) (func(context.Context) error, error) {
	if cfg.Endpoint == "" {
		return func(context.Context) error { return nil }, nil
	}
	res := resource.NewSchemaless(
		attribute.String("service.name", ServiceName),
		attribute.String("service.version", cfg.Version),
		attribute.String("host.name", hostname()),
	)
	mexp, err := otlpmetrichttp.New(ctx, otlpmetrichttp.WithEndpointURL(cfg.Endpoint+"/v1/metrics"))
	if err != nil {
		return nil, err
	}
	mp := sdkmetric.NewMeterProvider(
		sdkmetric.WithResource(res),
		sdkmetric.WithReader(sdkmetric.NewPeriodicReader(mexp, sdkmetric.WithInterval(60*time.Second))),
	)
	dropped, err := mp.Meter(scope).Int64Counter("otel.spans.dropped",
		metric.WithUnit("{span}"), metric.WithDescription("Spans dropped because the export queue was full"))
	if err != nil {
		return nil, err
	}
	texp, err := otlptracehttp.New(ctx,
		otlptracehttp.WithEndpointURL(cfg.Endpoint+"/v1/traces"),
		otlptracehttp.WithTimeout(10*time.Second),
		otlptracehttp.WithRetry(otlptracehttp.RetryConfig{Enabled: false}),
	)
	if err != nil {
		return nil, err
	}
	tp := sdktrace.NewTracerProvider(
		sdktrace.WithResource(res),
		sdktrace.WithSpanProcessor(NewDroppingProcessor(texp, DroppingOptions{
			MaxQueueSize: cfg.MaxQueueSize,
			OnDrop:       func(n int64) { dropped.Add(context.Background(), n) },
		})),
	)
	restore := SetTracerProvider(tp)
	return func(ctx context.Context) error {
		defer restore()
		return errors.Join(tp.Shutdown(ctx), mp.Shutdown(ctx))
	}, nil
}
