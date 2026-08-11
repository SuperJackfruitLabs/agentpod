package acpproxy

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"sort"
	"strings"
)

// Station is the subset of a fleet row `apn acp --list` prints.
// Field names verified against a live GET /api/fleet/agents on 2026-08-11 —
// the name is `agentName`, not `displayName`, and `nodeName` matters here
// because the whole point of Doors is reaching a station on another machine.
type Station struct {
	StationID     string   `json:"stationId"`
	AgentName     string   `json:"agentName"`
	NodeName      string   `json:"nodeName"`
	WorkspacePath string   `json:"workspacePath"`
	Harness       string   `json:"harness"`
	Status        string   `json:"status"`
	Capabilities  []string `json:"capabilities"`
}

// SupportsACP reports whether a station can host an agent session.
//
// A station without this capability cannot be attached to, and offering it in
// a list of things to attach to would only produce a confusing failure later.
func (s Station) SupportsACP() bool {
	for _, c := range s.Capabilities {
		if c == "acp" {
			return true
		}
	}
	return false
}

// ParseFleetAgents extracts stations from GET /api/fleet/agents.
//
// A pure function so the formatting and filtering are testable without a hub.
func ParseFleetAgents(body []byte) ([]Station, error) {
	var payload struct {
		Agents []Station `json:"agents"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil, fmt.Errorf("could not read the fleet list: %w", err)
	}
	return payload.Agents, nil
}

// FormatStations renders the list a person actually needs: the id to paste into
// an editor's agent command, and enough context to know which machine it is.
//
// Stations that cannot host a session are excluded rather than shown greyed
// out — this list exists to be copied from.
func FormatStations(stations []Station) string {
	var usable []Station
	for _, s := range stations {
		if s.SupportsACP() {
			usable = append(usable, s)
		}
	}

	if len(usable) == 0 {
		if len(stations) == 0 {
			return "No stations found. Enrol a machine first: apn enroll --hub <url> --token <token>\n"
		}
		return fmt.Sprintf(
			"None of your %d station(s) support agent sessions.\nThe harness must expose the `acp` capability — check `apn detect` on that machine.\n",
			len(stations))
	}

	// Grouped by machine: someone scanning this is usually looking for "the one
	// on the Hetzner box", not for a particular harness.
	sort.Slice(usable, func(i, j int) bool {
		if usable[i].NodeName != usable[j].NodeName {
			return usable[i].NodeName < usable[j].NodeName
		}
		if usable[i].Harness != usable[j].Harness {
			return usable[i].Harness < usable[j].Harness
		}
		return usable[i].AgentName < usable[j].AgentName
	})

	var b strings.Builder
	b.WriteString("\nStations you can attach an editor to:\n")

	node := ""
	for _, s := range usable {
		if s.NodeName != node {
			node = s.NodeName
			fmt.Fprintf(&b, "\n  %s\n", orUnknown(node, "(unnamed machine)"))
		}
		name := s.AgentName
		if name == "" {
			name = truncate(s.WorkspacePath, 30) // fall back to where it runs
		}
		fmt.Fprintf(&b, "    %-11s %-30s %s\n", s.Harness, truncate(name, 30), s.StationID)
		fmt.Fprintf(&b, "    %-11s %s\n", "", orUnknown(s.Status, "unknown"))
	}

	b.WriteString("\nAttach with:\n  apn acp --station <id>\n")
	return b.String()
}

func orUnknown(s, fallback string) string {
	if strings.TrimSpace(s) == "" {
		return fallback
	}
	return s
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	if n <= 1 {
		return s[:n]
	}
	return s[:n-1] + "…"
}

// ListStations fetches the caller's stations from the hub.
func ListStations(ctx context.Context, hub, token string) ([]Station, error) {
	if token == "" {
		return nil, fmt.Errorf("no hub token: set AGENTPOD_TOKEN or pass --token")
	}

	url := strings.TrimSuffix(hub, "/") + "/api/fleet/agents"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("could not reach the hub: %w", err)
	}
	defer res.Body.Close()

	if res.StatusCode == http.StatusUnauthorized {
		return nil, fmt.Errorf("hub rejected the token (401) — it may have expired")
	}
	if res.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("hub returned %d", res.StatusCode)
	}

	body, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return nil, err
	}
	return ParseFleetAgents(body)
}
