package fleetcli

import (
	"testing"
)

// The unit state of the node's systemd service rides along on each row. A restart
// only applies the configured endpoint when the unit is not drifted/errored, so the
// "(running X until restart)" hint is suppressed for those.
func TestTelemetryRowDetailUnitRendering(t *testing.T) {
	on := true
	str := func(s string) *string { return &s }
	guild := func(unit *string, detail string) TelemetryRow {
		return TelemetryRow{Enabled: &on, Endpoint: "http://foundry:4318", Effective: str(""), Unit: unit, UnitDetail: detail}
	}
	cases := []struct {
		name string
		row  TelemetryRow
		want string
	}{
		{"old node, no unit", guild(nil, ""), "enabled http://foundry:4318 (running off until restart)"},
		{"current", guild(str("current"), ""), "enabled http://foundry:4318 (running off until restart) unit: current"},
		{"reconciled", guild(str("reconciled"), ""), "enabled http://foundry:4318 (running off until restart) unit: reconciled"},
		{"stale", guild(str("stale"), ""), "enabled http://foundry:4318 (running off until restart) unit: stale (re-rendered on next set or restart)"},
		{"drifted", guild(str("drifted"), ""), "enabled http://foundry:4318 unit: drifted (manual edits)"},
		{"error with detail", guild(str("error"), "daemon-reload failed"), "enabled http://foundry:4318 unit: error: daemon-reload failed"},
		{"error without detail", guild(str("error"), ""), "enabled http://foundry:4318 unit: error"},
		{"n/a", guild(str("n/a"), ""), "enabled http://foundry:4318 (running off until restart) unit: n/a"},
	}
	for _, c := range cases {
		if got := c.row.Detail(); got != c.want {
			t.Errorf("%s: detail() = %q, want %q", c.name, got, c.want)
		}
	}
}
