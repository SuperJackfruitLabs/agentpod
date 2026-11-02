package fleetcli

import (
	"strings"
)

// TelemetryRow is one node's answer from GET/POST /api/nodes/telemetry.
type TelemetryRow struct {
	Name       string `json:"name"`
	NodeID     string `json:"nodeId"`
	Status     string `json:"status"`
	Endpoint   string `json:"endpoint"`
	Enabled    *bool  `json:"enabled"`
	Restarting bool   `json:"restarting"`
	Error      string `json:"error"`
	// Effective is the endpoint the node process started with (status only; absent
	// on older nodes). It differs from Endpoint until the node restarts.
	Effective *string `json:"effective"`
	// Unit is the state of the node's systemd unit (current, stale, reconciled,
	// drifted, error, n/a); nil on older nodes. UnitDetail explains an error.
	Unit       *string `json:"unit"`
	UnitDetail string  `json:"unitDetail"`
}

// unitBlocksRestart reports whether the node's unit is in a state where a restart
// would not pick up the configured endpoint.
func (r TelemetryRow) unitBlocksRestart() bool {
	return r.Unit != nil && (*r.Unit == "drifted" || *r.Unit == "error")
}

func (r TelemetryRow) Detail() string {
	var parts []string
	if r.Enabled != nil {
		if *r.Enabled {
			parts = append(parts, "enabled "+r.Endpoint)
		} else {
			parts = append(parts, "disabled")
		}
	}
	if r.Effective != nil && r.Enabled != nil {
		configured := ""
		if *r.Enabled {
			configured = r.Endpoint
		}
		if *r.Effective != configured {
			running := *r.Effective
			if running == "" {
				running = "off"
			}
			// A restart only applies the configured endpoint when the unit is
			// healthy; with a drifted or errored unit the hint would be a lie.
			if !r.unitBlocksRestart() {
				parts = append(parts, "(running "+running+" until restart)")
			}
		}
	}
	if r.Unit != nil {
		switch *r.Unit {
		case "drifted":
			parts = append(parts, "unit: drifted (manual edits)")
		case "error":
			if r.UnitDetail != "" {
				parts = append(parts, "unit: error: "+r.UnitDetail)
			} else {
				parts = append(parts, "unit: error")
			}
		case "stale":
			parts = append(parts, "unit: stale (re-rendered on next set or restart)")
		default:
			parts = append(parts, "unit: "+*r.Unit)
		}
	}
	if r.Restarting {
		parts = append(parts, "(restarting)")
	}
	if r.Error != "" {
		parts = append(parts, r.Error)
	}
	return strings.Join(parts, " ")
}
