package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/forgeapi"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/stkclient"
)

func runForgeAPI(t *testing.T, args []string, res forgeapi.SetupResult, err error) (code int, out, errOut string, got forgeapi.SetupOptions) {
	t.Helper()
	var o, e bytes.Buffer
	d := forgeAPIDeps{
		newClient: func(string, string) stkclient.Client { return nil },
		setup: func(_ context.Context, _ stkclient.Client, so forgeapi.SetupOptions) (forgeapi.SetupResult, error) {
			got = so
			return res, err
		},
	}
	code = forgeAPICmdWith(args, &o, &e, d)
	return code, o.String(), e.String(), got
}

func sepReport() stkclient.DoctorReport {
	return stkclient.DoctorReport{Isolation: stkclient.Isolation{Level: "separate-user", Method: "mode-bits", Reasons: []string{"store owned by stk"}}}
}

func TestForgeAPISetupParsesFlagsAndReportsSeparateUser(t *testing.T) {
	code, out, _, got := runForgeAPI(t, []string{"setup", "--user", "stkx", "--agent-uid", "1001", "--agent-uid=1002", "--state-dir", "/srv/stk"},
		forgeapi.SetupResult{Report: sepReport(), Installed: true}, nil)
	if code != 0 {
		t.Fatalf("code = %d", code)
	}
	if got.ServiceUser != "stkx" || len(got.AgentUIDs) != 2 || got.AgentUIDs[1] != 1002 || got.StateDir != "/srv/stk" {
		t.Fatalf("opts = %+v", got)
	}
	for _, want := range []string{"isolation: separate-user", "method:    mode-bits", "reason:    store owned by stk"} {
		if !strings.Contains(out, want) {
			t.Errorf("output missing %q:\n%s", want, out)
		}
	}
}

func TestForgeAPISetupSameUserIsExitZeroAndLabelledDegraded(t *testing.T) {
	r := forgeapi.SetupResult{Report: stkclient.DoctorReport{Isolation: stkclient.Isolation{Level: "same-user"}}, Degraded: true, Reason: "not running as root; run `sudo agentpod-node forge-api setup`"}
	code, out, _, _ := runForgeAPI(t, []string{"setup"}, r, nil)
	if code != 0 || !strings.Contains(out, "same-user (DEGRADED)") || !strings.Contains(out, "sudo agentpod-node forge-api setup") {
		t.Fatalf("code=%d out=%s", code, out)
	}
}

func TestForgeAPISetupErrorsExitNonZero(t *testing.T) {
	code, _, errOut, _ := runForgeAPI(t, []string{"setup"}, forgeapi.SetupResult{}, errors.New("boom"))
	if code != 1 || !strings.Contains(errOut, "boom") {
		t.Fatalf("code=%d err=%s", code, errOut)
	}
	if code, _, _, _ := runForgeAPI(t, []string{"setup", "--agent-uid", "x"}, forgeapi.SetupResult{}, nil); code != 2 {
		t.Fatalf("bad flag code = %d, want 2", code)
	}
	if code, _, _, _ := runForgeAPI(t, []string{"nope"}, forgeapi.SetupResult{}, nil); code != 2 {
		t.Fatalf("unknown verb code = %d, want 2", code)
	}
}

func TestForgeAPIIsRegisteredInHelp(t *testing.T) {
	if !isCommand("forge-api") || commandHelp("forge-api") == "" {
		t.Fatal("forge-api must be in the commands registry")
	}
}
