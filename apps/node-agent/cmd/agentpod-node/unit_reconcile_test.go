package main

import (
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/otelenv"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/service"
)

func TestUnitScope(t *testing.T) {
	cases := []struct {
		name     string
		path     string
		err      error
		ok, user bool
	}{
		{"error is n/a", "", otelenv.ErrNotService, false, false},
		{"system", otelenv.SystemPath, nil, true, false},
		{"user", "/home/u/.config/agentpod/otel.env", nil, true, true},
	}
	for _, c := range cases {
		user, ok := unitScope(func() (string, error) { return c.path, c.err })
		if ok != c.ok || (ok && user != c.user) {
			t.Errorf("%s: user=%v ok=%v", c.name, user, ok)
		}
	}
}

func TestReconcileUnitAtStartup(t *testing.T) {
	cases := []struct {
		state    service.UnitState
		scopeOK  bool
		wantExit bool
		wantLog  bool
	}{
		{service.UnitReconciled, true, true, true},
		{service.UnitCurrent, true, false, false},
		{service.UnitDrifted, true, false, true},
		{service.UnitError, true, false, true},
		{service.UnitNA, false, false, false},
	}
	for _, c := range cases {
		var exits []int
		var logs []string
		reconciled := 0
		reconcileUnitAtStartup(
			func() (string, error) {
				if !c.scopeOK {
					return "", otelenv.ErrNotService
				}
				return otelenv.SystemPath, nil
			},
			func(userScope bool, dryRun bool) service.ReconcileResult {
				reconciled++
				if dryRun || userScope {
					t.Errorf("%s: want real system-scope reconcile", c.state)
				}
				return service.ReconcileResult{State: c.state, Detail: "d"}
			},
			func(code int) { exits = append(exits, code) },
			func(f string, a ...any) { logs = append(logs, f) },
		)
		if c.wantExit != (len(exits) == 1 && exits[0] == 0) || len(exits) > 1 {
			t.Errorf("%s: exits=%v", c.state, exits)
		}
		if (len(logs) > 0) != c.wantLog {
			t.Errorf("%s: logs=%v", c.state, logs)
		}
		if !c.scopeOK && reconciled != 0 {
			t.Errorf("reconciled without scope")
		}
		if c.wantExit && !strings.Contains(logs[0], "restarting") {
			t.Errorf("log: %v", logs)
		}
	}
}
