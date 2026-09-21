package main

import (
	"errors"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
)

func TestDecideEnroll(t *testing.T) {
	cfg := config.Config{Hub: "https://hub", NodeID: "node_1", NodeSecret: "s"}
	valid := func(h, i, s string) (bool, error) { return true, nil }
	rejected := func(h, i, s string) (bool, error) { return false, nil }
	down := func(h, i, s string) (bool, error) { return false, errors.New("connection refused") }

	cases := []struct {
		name       string
		cfg        config.Config
		haveConfig bool
		hub        string
		force      bool
		check      func(h, i, s string) (bool, error)
		want       enrollDecision
	}{
		{"no existing config enrolls", config.Config{}, false, "https://hub", false, valid, decisionEnroll},
		{"force always re-enrolls", cfg, true, "https://hub", true, valid, decisionEnroll},
		{"hub mismatch re-enrolls", cfg, true, "https://other-hub", false, valid, decisionEnroll},
		{"valid credential on same hub keeps config", cfg, true, "https://hub", false, valid, decisionKeep},
		{"rejected credential re-enrolls", cfg, true, "https://hub", false, rejected, decisionEnroll},
		{"unreachable hub keeps config unverified", cfg, true, "https://hub", false, down, decisionKeepUnverified},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got, reason := decideEnroll(tc.cfg, tc.haveConfig, tc.hub, tc.force, tc.check)
			if got != tc.want {
				t.Fatalf("decision = %v (%s), want %v", got, reason, tc.want)
			}
			if reason == "" {
				t.Fatal("reason must be non-empty")
			}
		})
	}
}

func TestRenewedConfigPreservesOperatorSettings(t *testing.T) {
	existing := config.Config{
		Hub: "https://old.example", NodeID: "node_old", NodeSecret: "old-secret",
		HermesStartCmd: "hermes serve", OpenClawStartCmd: "openclaw gateway",
		CodexAcpBinary: "/opt/bin/codex-acp", CodexBinary: "/opt/bin/codex",
		NodeBinary: "/opt/bin/node", NativeSkillActivation: true,
	}
	got := renewedConfig(existing, "https://new.example", "node_new", "new-secret")
	if got.Hub != "https://new.example" || got.NodeID != "node_new" || got.NodeSecret != "new-secret" {
		t.Fatalf("identity = %#v, want refreshed values", got)
	}
	if got.HermesStartCmd != existing.HermesStartCmd || got.OpenClawStartCmd != existing.OpenClawStartCmd || got.CodexAcpBinary != existing.CodexAcpBinary || got.CodexBinary != existing.CodexBinary || got.NodeBinary != existing.NodeBinary || !got.NativeSkillActivation {
		t.Fatalf("operator configuration was not preserved: %#v", got)
	}
}
