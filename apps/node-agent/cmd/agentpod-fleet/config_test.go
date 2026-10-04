package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// TestConfigVerbsUseTheHubRoutes pins each `fleet config` subcommand to the
// route it is supposed to call, the same way TestAdminVerbsUseTheHubRoutes
// pins the admin verbs: these are thin wrappers, so the one thing that can
// really be wrong is which endpoint and method they picked.
func TestConfigVerbsUseTheHubRoutes(t *testing.T) {
	bin := build(t)
	for _, tc := range []struct {
		name   string
		args   []string
		method string
		path   string
	}{
		{"config settings", []string{"config", "settings"}, "GET", "/api/fleet/config/settings"},
		{"config drift", []string{"config", "drift"}, "GET", "/api/fleet/config/drift"},
		{"config show fleet-wide", []string{"config", "show"}, "GET", "/api/fleet/config/declared"},
		{"config show --node", []string{"config", "show", "--node", "nod_1"}, "GET", "/api/fleet/config/declared"},
		{"config show --station", []string{"config", "show", "--station", "st_1"}, "GET", "/api/stations/st_1/config"},
		{"config set fleet-wide", []string{"config", "set", "hermes.approvals.mode", "--value", "strict"}, "PUT", "/api/fleet/config/declared"},
		{"config set --station", []string{"config", "set", "hermes.approvals.mode", "--value", "strict", "--station", "st_1"}, "PUT", "/api/fleet/config/declared"},
		{"config set --node", []string{"config", "set", "hermes.approvals.mode", "--value", "strict", "--node", "nod_1"}, "PUT", "/api/fleet/config/declared"},
		{"config unset fleet-wide", []string{"config", "unset", "hermes.approvals.mode"}, "DELETE", "/api/fleet/config/declared"},
		{"config unset --station", []string{"config", "unset", "hermes.approvals.mode", "--station", "st_1"}, "DELETE", "/api/fleet/config/declared"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var gotMethod, gotPath string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotMethod, gotPath = r.Method, r.URL.Path
				_, _ = w.Write([]byte(`{"ok":true}`))
			}))
			defer srv.Close()
			_, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}, tc.args...)
			if code != 0 {
				t.Fatalf("exit = %d", code)
			}
			if gotMethod != tc.method || gotPath != tc.path {
				t.Errorf("called %s %s, want %s %s", gotMethod, gotPath, tc.method, tc.path)
			}
		})
	}
}

// TestConfigSetRequiresValue — a declaration with no value is not a
// declaration (the contract itself refuses an omitted `value`, distinct from
// an explicit null). The CLI should catch this before spending a round trip.
func TestConfigSetRequiresValue(t *testing.T) {
	bin := build(t)
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	out, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")},
		"config", "set", "hermes.approvals.mode")
	if code == 0 || called {
		t.Errorf("set without --value: exit=%d, requestSent=%v — want a refusal, no request", code, called)
	}
	if !strings.Contains(out, "--value") {
		t.Errorf("refusal should name the missing flag, got:\n%s", out)
	}
}

// TestConfigSetBodyTargetsExactlyOneLevel checks that an unset --station/--node
// flag is sent as JSON null rather than the empty string, so "not this level"
// and "the empty string" cannot arrive looking alike — the exact job
// `nullable` is written to do.
func TestConfigSetBodyTargetsExactlyOneLevel(t *testing.T) {
	bin := build(t)
	for _, tc := range []struct {
		name          string
		args          []string
		wantStationID any
		wantNodeID    any
	}{
		{"fleet-wide", []string{"config", "set", "hermes.approvals.mode", "--value", "strict"}, nil, nil},
		{"station-scoped", []string{"config", "set", "hermes.approvals.mode", "--value", "strict", "--station", "st_1"}, "st_1", nil},
		{"node-scoped", []string{"config", "set", "hermes.approvals.mode", "--value", "strict", "--node", "nod_1"}, nil, "nod_1"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewDecoder(r.Body).Decode(&body)
				_, _ = w.Write([]byte(`{"ok":true}`))
			}))
			defer srv.Close()
			_, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}, tc.args...)
			if code != 0 {
				t.Fatalf("exit = %d", code)
			}
			if body["settingId"] != "hermes.approvals.mode" || body["value"] != "strict" {
				t.Errorf("body = %v, missing settingId/value", body)
			}
			if body["stationId"] != tc.wantStationID {
				t.Errorf("stationId = %v, want %v", body["stationId"], tc.wantStationID)
			}
			if body["nodeId"] != tc.wantNodeID {
				t.Errorf("nodeId = %v, want %v", body["nodeId"], tc.wantNodeID)
			}
		})
	}
}

// TestConfigUsageSaysSetDoesNotWrite is the wording constraint carried from
// earlier review: `set` records a declaration, it does not write to a
// station. A user who believes `set` changed a machine has been misled, so
// this sentence has to survive in the usage text, not just in a comment.
func TestConfigUsageSaysSetDoesNotWrite(t *testing.T) {
	bin := build(t)
	out, _ := run(t, bin, nil, "config", "--help")
	if !strings.Contains(out, "does not write to a station") {
		t.Errorf("config usage should say `set` does not write to a station, got:\n%s", out)
	}
}

// TestConfigSetPassesServerReasonVerbatim is the second wording constraint:
// UNKNOWN_SETTING means either "no such setting" or "the registry could not
// be read because nothing was reachable", distinguished only by the server's
// free-text `reason`. The CLI must print that reason as it arrives and must
// never itself claim the setting does not exist — a user told that when a
// node was merely offline would go looking for the wrong problem.
func TestConfigSetPassesServerReasonVerbatim(t *testing.T) {
	bin := build(t)
	const reason = "the registry could not be read: no reachable node could confirm this setting"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(400)
		_, _ = w.Write([]byte(`{"error":"UNKNOWN_SETTING","settingId":"hermes.approvals.mode","reason":"` + reason + `"}`))
	}))
	defer srv.Close()
	out, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")},
		"config", "set", "hermes.approvals.mode", "--value", "strict")
	if code == 0 {
		t.Fatalf("a 400 from the hub should not look like success")
	}
	if !strings.Contains(out, reason) {
		t.Errorf("CLI should print the server's reason verbatim, got:\n%s", out)
	}
	if strings.Contains(strings.ToLower(out), "no such setting") {
		t.Errorf("CLI must not assert non-existence on top of the server's reason, got:\n%s", out)
	}
}

// TestUnknownFleetConfigVerbExitsTwo matches the other families' handling of
// an unrecognised subcommand.
func TestUnknownFleetConfigVerbExitsTwo(t *testing.T) {
	bin := build(t)
	_, code := run(t, bin, nil, "config", "nonsense")
	if code != 2 {
		t.Fatalf("unknown `config` subcommand should exit 2, got %d", code)
	}
}
