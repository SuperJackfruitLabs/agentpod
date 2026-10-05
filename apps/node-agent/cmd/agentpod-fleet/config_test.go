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

// TestConfigPlanAsksTheStationThenPlans — `plan` takes no SETTING_ID (see
// configUsage): it GETs the station's own merged declarations, the same
// call `show --station` makes, and plans writing every one of them, with
// `value` omitted so the hub resolves each from the declaration. This is
// "the edit that would be made" for a station, not for one setting.
func TestConfigPlanAsksTheStationThenPlans(t *testing.T) {
	bin := build(t)
	const digest = "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1"
	var gotPlanBody map[string]any
	var sawGet, sawPost bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/api/stations/st_1/config":
			sawGet = true
			_, _ = w.Write([]byte(`{"observations":[{"settingId":"hermes.approvals.mode","stationId":"st_1","state":"drifted"}]}`))
		case r.Method == http.MethodPost && r.URL.Path == "/api/stations/st_1/config/plan":
			sawPost = true
			_ = json.NewDecoder(r.Body).Decode(&gotPlanBody)
			_, _ = w.Write([]byte(`{"schemaVersion":1,"operationId":"cfgop_1","stationKey":"k","entries":[],"beforeSha256":"x","diff":"","diffTruncated":false,"noOp":false,"restartRequired":false,"createdAt":"2026-10-05T00:00:00Z","planDigest":"` + digest + `"}`))
		default:
			t.Errorf("unexpected request: %s %s", r.Method, r.URL.Path)
		}
	}))
	defer srv.Close()
	out, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")},
		"config", "plan", "--station", "st_1")
	if code != 0 {
		t.Fatalf("exit = %d: %s", code, out)
	}
	if !sawGet || !sawPost {
		t.Fatalf("plan should GET the station's config then POST a plan; sawGet=%v sawPost=%v", sawGet, sawPost)
	}
	settings, _ := gotPlanBody["settings"].([]any)
	if len(settings) != 1 {
		t.Fatalf("plan body settings = %v, want exactly the one declared setting", gotPlanBody["settings"])
	}
	entry, _ := settings[0].(map[string]any)
	if entry["settingId"] != "hermes.approvals.mode" {
		t.Errorf("settings[0] = %v", entry)
	}
	if _, hasValue := entry["value"]; hasValue {
		t.Errorf("plan should omit value and let the hub resolve it from the declaration, got %v", entry)
	}
	if !strings.Contains(out, digest) {
		t.Errorf("plan must print the digest `apply` needs, got:\n%s", out)
	}
}

// TestConfigPlanRequiresStation matches set/unset's style: a usage error
// before any request, not a hub round trip that then fails.
func TestConfigPlanRequiresStation(t *testing.T) {
	bin := build(t)
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		_, _ = w.Write([]byte(`{}`))
	}))
	defer srv.Close()
	out, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}, "config", "plan")
	if code == 0 || called {
		t.Errorf("plan without --station: exit=%d, requestSent=%v — want a refusal, no request", code, called)
	}
	if !strings.Contains(out, "--station") {
		t.Errorf("refusal should name the missing flag, got:\n%s", out)
	}
}

// TestConfigInspectCallsOperationRoute pins `inspect` to the one route it
// reads from: a GET of the station's own operation record, never a re-plan
// (`config.inspect` is the sibling of `config.plan`/`config.apply` — it
// never re-derives).
func TestConfigInspectCallsOperationRoute(t *testing.T) {
	bin := build(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/api/stations/st_1/config/operations/cfgop_1" {
			t.Errorf("route = %s %s", r.Method, r.URL.Path)
		}
		_, _ = w.Write([]byte(`{"phase":"planned"}`))
	}))
	defer srv.Close()
	out, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")},
		"config", "inspect", "--station", "st_1", "--operation", "cfgop_1")
	if code != 0 || !strings.Contains(out, `"phase":"planned"`) {
		t.Fatalf("inspect failed (%d): %s", code, out)
	}
}

// TestConfigInspectRequiresStationAndOperation checks flag parsing for the
// inspect verb: either flag missing is a usage error, not a request.
func TestConfigInspectRequiresStationAndOperation(t *testing.T) {
	bin := build(t)
	if _, code := run(t, bin, nil, "config", "inspect", "--station", "st_1"); code != 2 {
		t.Errorf("inspect without --operation should exit 2, got %d", code)
	}
	if _, code := run(t, bin, nil, "config", "inspect", "--operation", "cfgop_1"); code != 2 {
		t.Errorf("inspect without --station should exit 2, got %d", code)
	}
}

// TestConfigApplyCallsApplyRoute pins `apply` to
// POST /api/stations/:stationId/config/apply with {operationId, planDigest}.
func TestConfigApplyCallsApplyRoute(t *testing.T) {
	bin := build(t)
	const digest = "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2"
	var body map[string]string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/stations/st_1/config/apply" {
			t.Errorf("route = %s %s", r.Method, r.URL.Path)
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		_, _ = w.Write([]byte(`{"phase":"applied"}`))
	}))
	defer srv.Close()
	out, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")},
		"config", "apply", "--station", "st_1", "--operation", "cfgop_1", "--plan-digest", digest)
	if code != 0 || !strings.Contains(out, `"phase":"applied"`) {
		t.Fatalf("apply failed (%d): %s", code, out)
	}
	if body["operationId"] != "cfgop_1" || body["planDigest"] != digest {
		t.Errorf("apply body = %v", body)
	}
}

// TestConfigApplyWithoutPlanDigestIsRefused is the hard constraint from the
// brief: apply must NEVER fall back to "apply whatever the current plan
// is" — the whole point of --plan-digest is that a human reviewed one
// specific plan, and re-deriving it here would discard that review. The CLI
// must refuse before any request reaches the hub.
func TestConfigApplyWithoutPlanDigestIsRefused(t *testing.T) {
	bin := build(t)
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	out, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")},
		"config", "apply", "--station", "st_1", "--operation", "cfgop_1")
	if code == 0 || called {
		t.Errorf("apply without --plan-digest: exit=%d, requestSent=%v — want a refusal, no request", code, called)
	}
	if !strings.Contains(out, "--plan-digest") {
		t.Errorf("refusal should name the missing flag, got:\n%s", out)
	}
}

// TestConfigApplyRequiresStationAndOperation checks the rest of apply's flag
// parsing, separate from the plan-digest case above.
func TestConfigApplyRequiresStationAndOperation(t *testing.T) {
	bin := build(t)
	digest := strings.Repeat("c", 64)
	if _, code := run(t, bin, nil, "config", "apply", "--operation", "cfgop_1", "--plan-digest", digest); code != 2 {
		t.Errorf("apply without --station should exit 2, got %d", code)
	}
	if _, code := run(t, bin, nil, "config", "apply", "--station", "st_1", "--plan-digest", digest); code != 2 {
		t.Errorf("apply without --operation should exit 2, got %d", code)
	}
}

// TestConfigUsageListsEveryVerbLine: settings, show twice, set twice (--value
// and --json), unset, drift, plan, inspect, apply — ten lines inside the
// `usage:` block, which is the block only, not the worked examples in the
// prose below it.
func TestConfigUsageListsEveryVerbLine(t *testing.T) {
	bin := build(t)
	out, _ := run(t, bin, nil, "config", "--help")
	count := 0
	inBlock := false
	for _, line := range strings.Split(out, "\n") {
		trimmed := strings.TrimSpace(line)
		if strings.HasPrefix(trimmed, "usage:") {
			inBlock = true
			continue
		}
		if inBlock && trimmed == "" {
			break // the usage block ends at its first blank line
		}
		if inBlock && strings.HasPrefix(trimmed, "fleet config ") {
			count++
		}
	}
	if count != 10 {
		t.Errorf("config usage should list ten verb lines (settings, show x2, set x2, unset, drift, plan, inspect, apply), got %d:\n%s", count, out)
	}
	for _, verb := range []string{"fleet config plan", "fleet config inspect", "fleet config apply"} {
		if !strings.Contains(out, verb) {
			t.Errorf("config usage should mention %q, got:\n%s", verb, out)
		}
	}
}

// TestConfigUsageSaysApplyWrites is the second wording requirement from the
// brief: `apply` is the verb that writes, and it needs a digest from `plan`.
// An operator should not have to discover that the gap between declaring
// and applying is deliberate.
func TestConfigUsageSaysApplyWrites(t *testing.T) {
	bin := build(t)
	out, _ := run(t, bin, nil, "config", "--help")
	lower := strings.ToLower(out)
	if !strings.Contains(out, "`apply`") || !strings.Contains(lower, "writes") {
		t.Errorf("config usage should say `apply` is the verb that writes, got:\n%s", out)
	}
	if !strings.Contains(out, "--plan-digest") {
		t.Errorf("config usage should mention --plan-digest, got:\n%s", out)
	}
	if !strings.Contains(out, "does not write to a station") {
		t.Errorf("config usage must keep saying `set` does not write to a station, got:\n%s", out)
	}
}

// TestConfigSetDeclaresAListValue is finding 6: `--value` could only ever
// produce a JSON string, so `hermes.approvals.command_allowlist` — an
// `additive-only` setting, the policy this whole feature was written for —
// could not be declared from the CLI at all. The hub stores this field
// verbatim as jsonb and the node refuses a non-list, so getting the JSON type
// right is the CLI's job and nobody else's.
func TestConfigSetDeclaresAListValue(t *testing.T) {
	bin := build(t)
	const id = "hermes.approvals.command_allowlist"
	for _, tc := range []struct {
		name string
		args []string
		want any
	}{
		{"one --value is still a string", []string{"config", "set", id, "--value", "git status"}, "git status"},
		{
			"repeated --value is a list, in the order given",
			[]string{"config", "set", id, "--value", "git status", "--value", "ls"},
			[]any{"git status", "ls"},
		},
		{
			"--json declares a one-entry list, which repeating cannot",
			[]string{"config", "set", id, "--json", `["git status"]`},
			[]any{"git status"},
		},
		{"--json declares a number as a number", []string{"config", "set", "hermes.approvals.timeout", "--json", "900"}, float64(900)},
		{"--json declares a bool as a bool", []string{"config", "set", "hermes.approvals.mode", "--json", "true"}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var body map[string]any
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_ = json.NewDecoder(r.Body).Decode(&body)
				_, _ = w.Write([]byte(`{"ok":true}`))
			}))
			defer srv.Close()
			out, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}, tc.args...)
			if code != 0 {
				t.Fatalf("exit = %d: %s", code, out)
			}
			got, _ := json.Marshal(body["value"])
			want, _ := json.Marshal(tc.want)
			if string(got) != string(want) {
				t.Errorf("value = %s, want %s", got, want)
			}
		})
	}
}

// --value and --json answering the same question two ways must not both be
// accepted — the body can carry one value, and silently preferring one of them
// is how a declaration ends up being something nobody typed.
func TestConfigSetRefusesValueAndJSONTogether(t *testing.T) {
	bin := build(t)
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	out, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")},
		"config", "set", "hermes.approvals.mode", "--value", "strict", "--json", `"strict"`)
	if code == 0 || called {
		t.Errorf("exit=%d requestSent=%v — want a refusal, no request", code, called)
	}
	if !strings.Contains(out, "not both") {
		t.Errorf("the refusal should say they are mutually exclusive, got:\n%s", out)
	}
}

// Minor 3. `declaredValue` detects "flag not given" by `len(values) == 0`,
// where the old single-flag code used `*value == ""` and so refused both that
// and an explicitly empty entry. An empty allowlist entry or an empty
// approvals mode is a quoting mistake, not a declaration, and `--value ""`
// used to exit 2 — it still does.
func TestConfigSetRefusesAnEmptyValue(t *testing.T) {
	bin := build(t)
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	for _, args := range [][]string{
		{"config", "set", "hermes.approvals.mode", "--value", ""},
		{"config", "set", "hermes.approvals.command_allowlist", "--value", "ls", "--value", ""},
	} {
		called = false
		out, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")}, args...)
		if code == 0 || called {
			t.Errorf("%v: exit=%d requestSent=%v — want a refusal, no request", args, code, called)
		}
		if !strings.Contains(out, "--value cannot be empty") {
			t.Errorf("%v: the refusal should name the flag, got:\n%s", args, out)
		}
	}
}

func TestConfigSetRefusesJSONItCannotParse(t *testing.T) {
	bin := build(t)
	called := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		_, _ = w.Write([]byte(`{"ok":true}`))
	}))
	defer srv.Close()
	out, code := run(t, bin, []string{"AGENTPOD_HUB=" + srv.URL, "AGENTPOD_TOKEN=" + jwtish("prn_operator", "human")},
		"config", "set", "hermes.approvals.command_allowlist", "--json", "[not json")
	if code == 0 || called {
		t.Errorf("exit=%d requestSent=%v — want a refusal, no request", code, called)
	}
	if !strings.Contains(out, "--json") {
		t.Errorf("the refusal should name the flag, got:\n%s", out)
	}
}

// The help has to say how a list is declared, or the capability is unreachable
// for anyone who does not read the source. The docs page made the same
// overclaim this fixes: it listed `command_allowlist` among the settings the
// registry covers while `--value` could not express one.
func TestConfigUsageSaysHowToDeclareAList(t *testing.T) {
	bin := build(t)
	out, _ := run(t, bin, nil, "config", "--help")
	if !strings.Contains(out, "--json") {
		t.Errorf("config usage should document --json, got:\n%s", out)
	}
	if !strings.Contains(out, "repeating --value") {
		t.Errorf("config usage should say a list is declared by repeating --value, got:\n%s", out)
	}
}
