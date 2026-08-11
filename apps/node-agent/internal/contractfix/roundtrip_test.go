// Package contractfix holds no code — only a test that proves the hand-written
// Go mirrors of the zod contract still round-trip its wire shapes losslessly.
//
// Why round-trip rather than unmarshal: encoding/json silently ignores unknown
// fields, so merely unmarshalling a fixture proves nothing. Marshalling the
// result back and comparing to the source catches a Go struct that has fallen
// behind the schema — the field survives the fixture but vanishes on the way
// out.
//
// Fixtures are generated from the zod schemas themselves:
//
//	cd packages/contract && bun run scripts/emit-go-fixtures.ts
//
// CI runs the same script with --check, so a contract change that never had its
// fixtures regenerated fails there rather than in production.
package contractfix

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/gateway"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/host"
)

// normalise decodes JSON into generic maps so comparison ignores key order and
// integer/float representation differences.
func normalise(t *testing.T, b []byte) any {
	t.Helper()
	var v any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatalf("normalise: %v", err)
	}
	return v
}

func roundTrip(t *testing.T, file string, target any) {
	t.Helper()

	src, err := os.ReadFile(filepath.Join("testdata", file))
	if err != nil {
		t.Fatalf("read fixture %s: %v (run the emitter — see the package doc)", file, err)
	}

	if err := json.Unmarshal(src, target); err != nil {
		t.Fatalf("%s: the Go struct cannot decode a valid contract value: %v", file, err)
	}

	out, err := json.Marshal(target)
	if err != nil {
		t.Fatalf("%s: re-marshal: %v", file, err)
	}

	want, got := normalise(t, src), normalise(t, out)
	if !reflect.DeepEqual(want, got) {
		t.Errorf(
			"%s: the Go mirror has drifted from the contract.\n  contract: %s\n  go:       %s\n"+
				"A field present in the schema but missing from the struct disappears here.",
			file, src, out,
		)
	}
}

func TestHostInfoRoundTrips(t *testing.T) {
	roundTrip(t, "host_info.json", &host.HostInfo{})
}

func TestStationHealthRoundTrips(t *testing.T) {
	// Both variants matter. The full one catches a missing field; the all-nulls
	// one catches a Go type that cannot represent null — a plain int64 would
	// decode null to 0 and re-marshal as 0, turning "unknown" into "zero".
	t.Run("all metrics present", func(t *testing.T) {
		roundTrip(t, "station_health_full.json", &gateway.HealthReport{})
	})
	t.Run("all metrics null", func(t *testing.T) {
		roundTrip(t, "station_health_nulls.json", &gateway.HealthReport{})
	})
}

// The health frame's envelope is built inline as a map[string]any in
// client.go, so there is no Go type to round-trip. This test pins the parts
// that a struct does cover, and documents the gap: an untyped map can drift
// from the contract without any test noticing.
func TestHealthFrameStationsRoundTrip(t *testing.T) {
	src, err := os.ReadFile(filepath.Join("testdata", "health_frame.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}

	var frame struct {
		Type     string                 `json:"type"`
		Stations []gateway.HealthReport `json:"stations"`
	}
	if err := json.Unmarshal(src, &frame); err != nil {
		t.Fatalf("decode health frame: %v", err)
	}

	if frame.Type != "health" {
		t.Errorf("frame type = %q, want %q — the wire literal changed", frame.Type, "health")
	}
	if len(frame.Stations) != 2 {
		t.Fatalf("stations = %d, want 2", len(frame.Stations))
	}

	out, err := json.Marshal(frame)
	if err != nil {
		t.Fatalf("re-marshal: %v", err)
	}
	if want, got := normalise(t, src), normalise(t, out); !reflect.DeepEqual(want, got) {
		t.Errorf("health frame drifted.\n  contract: %s\n  go:       %s", src, out)
	}
}

// The hello frame carries node capabilities, which gate whole features in the
// console — a capability silently dropped here is a feature that never appears
// and produces no error anywhere.
//
// Until this test existed the frame was an inline map[string]any in client.go
// and nothing checked it at all, exactly the gap TestHealthFrameStationsRoundTrip
// warns about one function above.
func TestHelloRoundTrips(t *testing.T) {
	roundTrip(t, "hello.json", &gateway.HelloMsg{})
}
