package acpproxy

import (
	"strings"
	"testing"
)

const fleetJSON = `{
  "stats": {"total": 3},
  "agents": [
    {"stationId":"station_b","agentName":"research","nodeName":"mac","harness":"codex","status":"online","capabilities":["health","acp"]},
    {"stationId":"station_a","agentName":"gateway","nodeName":"mac","harness":"openclaw","status":"offline","capabilities":["health","logs"]},
    {"stationId":"station_c","agentName":"api","nodeName":"hetzner","harness":"claude-code","status":"online","capabilities":["acp","terminal"]}
  ]
}`

func TestParseFleetAgents(t *testing.T) {
	got, err := ParseFleetAgents([]byte(fleetJSON))
	if err != nil {
		t.Fatalf("ParseFleetAgents: %v", err)
	}
	if len(got) != 3 {
		t.Fatalf("parsed %d stations, want 3", len(got))
	}
	if got[0].StationID != "station_b" || got[0].Harness != "codex" {
		t.Errorf("first station = %+v", got[0])
	}
}

func TestSupportsACP(t *testing.T) {
	yes := Station{Capabilities: []string{"health", "acp"}}
	no := Station{Capabilities: []string{"health", "logs"}}
	if !yes.SupportsACP() {
		t.Error("a station advertising acp should support sessions")
	}
	if no.SupportsACP() {
		t.Error("a station without acp must not be offered as attachable")
	}
}

func TestFormatOmitsStationsThatCannotHostASession(t *testing.T) {
	// This list exists to be copied from. Showing a station you cannot attach to
	// only produces a confusing failure one command later.
	stations, _ := ParseFleetAgents([]byte(fleetJSON))
	out := FormatStations(stations)

	if !strings.Contains(out, "station_b") || !strings.Contains(out, "station_c") {
		t.Errorf("attachable stations missing from output:\n%s", out)
	}
	if strings.Contains(out, "station_a") {
		t.Errorf("a station without the acp capability was offered:\n%s", out)
	}
}

func TestFormatShowsTheAttachCommand(t *testing.T) {
	stations, _ := ParseFleetAgents([]byte(fleetJSON))
	if out := FormatStations(stations); !strings.Contains(out, "apn acp --station") {
		t.Errorf("output does not say how to use an id:\n%s", out)
	}
}

func TestFormatDistinguishesNoStationsFromNoneUsable(t *testing.T) {
	// Two different problems needing two different fixes: enrol a machine, or
	// check why the harness is not advertising acp. One message for both would
	// send someone down the wrong path.
	empty := FormatStations(nil)
	if !strings.Contains(empty, "apn enroll") {
		t.Errorf("an empty fleet should point at enrolment:\n%s", empty)
	}

	noneUsable := FormatStations([]Station{
		{StationID: "s1", Harness: "openclaw", Capabilities: []string{"health"}},
	})
	if strings.Contains(noneUsable, "apn enroll") {
		t.Errorf("stations exist, so this must not suggest enrolling:\n%s", noneUsable)
	}
	if !strings.Contains(noneUsable, "acp") {
		t.Errorf("should name the missing capability:\n%s", noneUsable)
	}
}

func TestFormatIsOrderedForScanning(t *testing.T) {
	stations, _ := ParseFleetAgents([]byte(fleetJSON))
	out := FormatStations(stations)
	// Sorted by harness: claude-code before codex.
	if strings.Index(out, "claude-code") > strings.Index(out, "codex") {
		t.Errorf("output is not sorted by harness:\n%s", out)
	}
}

func TestListStationsRequiresAToken(t *testing.T) {
	if _, err := ListStations(t.Context(), "https://h", ""); err == nil ||
		!strings.Contains(err.Error(), "AGENTPOD_TOKEN") {
		t.Errorf("err = %v, want a message naming AGENTPOD_TOKEN", err)
	}
}
