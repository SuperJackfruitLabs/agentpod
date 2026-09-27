package main

import (
	"context"
	"fmt"
	"sync/atomic"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// countingDescriptor is a fake harness that reports stationCount stations and
// counts how many times Detect is called.
type countingDescriptor struct {
	stationCount int
	detects      atomic.Int64

	// healthFor, when true, makes the fake implement HealthForStation.
	healthFor bool
}

func (c *countingDescriptor) Harness() string { return "counting" }

func (c *countingDescriptor) Detect() ([]descriptor.Station, error) {
	c.detects.Add(1)
	stations := make([]descriptor.Station, 0, c.stationCount)
	for i := 0; i < c.stationCount; i++ {
		ws := fmt.Sprintf("/tmp/ws-%d", i)
		stations = append(stations, descriptor.Station{
			Key:           fmt.Sprintf("counting:%d", i),
			Harness:       "counting",
			Kind:          "leaf",
			WorkspacePath: &ws,
		})
	}
	return stations, nil
}

// Health resolves the key the expensive way — by re-running Detect — which is
// exactly what the real workspace descriptors do.
func (c *countingDescriptor) Health(key string) (descriptor.Health, error) {
	stations, err := c.Detect()
	if err != nil {
		return descriptor.Health{}, err
	}
	for _, s := range stations {
		if s.Key == key {
			return descriptor.Health{Running: true}, nil
		}
	}
	return descriptor.Health{}, fmt.Errorf("no such station %q", key)
}

func (c *countingDescriptor) ListDir(string, string) ([]descriptor.FsEntry, error) {
	return nil, nil
}
func (c *countingDescriptor) ReadFile(string, string, int64) ([]byte, string, bool, error) {
	return nil, "", false, nil
}
func (c *countingDescriptor) TailLogs(context.Context, string, bool, func([]byte) error) error {
	return nil
}

// countingWithHealthFor is countingDescriptor plus the HealthForStation
// fast path.
type countingWithHealthFor struct{ countingDescriptor }

func (c *countingWithHealthFor) HealthFor(s descriptor.Station) (descriptor.Health, error) {
	if s.WorkspacePath == nil || *s.WorkspacePath == "" {
		return c.Health(s.Key)
	}
	return descriptor.Health{Running: true}, nil
}

// TestGatherHealthReportsDetectsOncePerSweep is the regression guard for the
// O(N²) health sweep.
//
// gatherHealthReports used to call d.Health(s.Key) for each station, and for
// the workspace harnesses Health(key) resolves the key by re-running Detect.
// One sweep of N stations therefore triggered 1+N host scans, each of which
// forks git once per project: on a 26-project host that was 702 git processes
// every 30 s.
func TestGatherHealthReportsDetectsOncePerSweep(t *testing.T) {
	const stations = 12

	fake := &countingWithHealthFor{countingDescriptor{stationCount: stations, healthFor: true}}
	reg := descriptor.NewRegistry()
	reg.Register(fake)

	reports := gatherHealthReports(reg)

	if len(reports) != stations {
		t.Fatalf("got %d reports, want %d", len(reports), stations)
	}
	for _, r := range reports {
		if !r.OK {
			t.Fatalf("station %s reported not-OK; the fast path must still produce health", r.Key)
		}
	}

	// One DetectAll for the sweep. Anything more means health is being resolved
	// per station, which is the quadratic path.
	if got := fake.detects.Load(); got != 1 {
		t.Fatalf("Detect called %d times for a %d-station sweep, want exactly 1; "+
			"health is being resolved per station (O(N^2) host scans)", got, stations)
	}
}

// TestGatherHealthReportsFallsBackToHealth asserts a descriptor that does NOT
// implement HealthForStation still works — it just pays the old cost. The
// fast path is an optimisation, never a requirement.
func TestGatherHealthReportsFallsBackToHealth(t *testing.T) {
	const stations = 3

	fake := &countingDescriptor{stationCount: stations}
	reg := descriptor.NewRegistry()
	reg.Register(fake)

	reports := gatherHealthReports(reg)

	if len(reports) != stations {
		t.Fatalf("got %d reports, want %d", len(reports), stations)
	}
	for _, r := range reports {
		if !r.OK || !r.Running {
			t.Fatalf("station %s: OK=%v Running=%v, want both true via the Health fallback",
				r.Key, r.OK, r.Running)
		}
	}
}
