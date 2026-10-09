package main

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/mcpproxy"
)

func mcpProxyFixture(t *testing.T) (cfgPath, statePath string) {
	t.Helper()
	dir := t.TempDir()
	cfgPath = filepath.Join(dir, "config.json")
	statePath = filepath.Join(dir, mcpproxy.StateFileName)
	if err := config.Save(cfgPath, config.Config{Hub: "https://hub.example", NodeID: "n", NodeSecret: "s",
		MCPProxy: &config.MCPProxy{Stations: []string{"station_a", "station_b"}}}); err != nil {
		t.Fatal(err)
	}
	if err := mcpproxy.OpenStore(statePath).Ensure([]string{"station_a", "station_b"}); err != nil {
		t.Fatal(err)
	}
	return cfgPath, statePath
}

func secretIn(t *testing.T, statePath, station string) string {
	t.Helper()
	s, _, err := mcpproxy.OpenStore(statePath).Secret(station)
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestApnMCPProxyRotateChangesOnlyTheNamedSecretAndPrintsNone(t *testing.T) {
	cfgPath, statePath := mcpProxyFixture(t)
	a, b := secretIn(t, statePath, "station_a"), secretIn(t, statePath, "station_b")
	var out, errOut bytes.Buffer
	if code := mcpProxyCmd([]string{"rotate", "station_a"}, cfgPath, statePath, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if secretIn(t, statePath, "station_a") == a {
		t.Fatal("station_a kept its secret")
	}
	if secretIn(t, statePath, "station_b") != b {
		t.Fatal("station_b was rotated too")
	}
	all := out.String() + errOut.String()
	if strings.Contains(all, a) || strings.Contains(all, secretIn(t, statePath, "station_a")) {
		t.Fatal("a secret was printed")
	}
	if !strings.Contains(out.String(), "station_a") {
		t.Fatalf("output does not name the station: %q", out.String())
	}
}

func TestApnMCPProxyRotateRefusesAStationTheProxyDoesNotServe(t *testing.T) {
	cfgPath, statePath := mcpProxyFixture(t)
	var out, errOut bytes.Buffer
	if code := mcpProxyCmd([]string{"rotate", "station_z"}, cfgPath, statePath, &out, &errOut); code != 1 {
		t.Fatalf("exit %d; want 1", code)
	}
}

func TestApnMCPProxyRotateAllRotatesEveryConfiguredStation(t *testing.T) {
	cfgPath, statePath := mcpProxyFixture(t)
	a, b := secretIn(t, statePath, "station_a"), secretIn(t, statePath, "station_b")
	var out, errOut bytes.Buffer
	if code := mcpProxyCmd([]string{"rotate"}, cfgPath, statePath, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if secretIn(t, statePath, "station_a") == a || secretIn(t, statePath, "station_b") == b {
		t.Fatal("rotate with no station left a secret unchanged")
	}
}

func TestApnMCPProxyStatusListsStationsWithoutSecrets(t *testing.T) {
	cfgPath, statePath := mcpProxyFixture(t)
	var out, errOut bytes.Buffer
	if code := mcpProxyCmd([]string{"status"}, cfgPath, statePath, &out, &errOut); code != 0 {
		t.Fatalf("exit %d: %s", code, errOut.String())
	}
	if !strings.Contains(out.String(), "station_a") || strings.Contains(out.String(), secretIn(t, statePath, "station_a")) {
		t.Fatalf("status output: %q", out.String())
	}
	fi, _ := os.Stat(statePath)
	if fi.Mode().Perm() != 0o600 {
		t.Fatalf("state mode %v", fi.Mode().Perm())
	}
}
