package config

import ("path/filepath"; "reflect"; "testing")

func TestSaveLoadRoundTrip(t *testing.T) {
  p := filepath.Join(t.TempDir(), "config.json")
  want := Config{
    Hub: "http://h", NodeID: "node_1", NodeSecret: "s",
    HermesStartCmd: "hermes gateway", OpenClawStartCmd: "openclaw gateway",
    OpenClawGatewayURL: "wss://gw.example:18789",
    OpenClawTokenFile: "/etc/agentpod/openclaw.token",
    OpenClawSessionLabel: "console",
    ClaudeCodeAcpBinary: "/opt/bin/claude-agent-acp",
    ClaudeCodeBinary: "/usr/local/bin/claude",
    CodexAcpBinary: "/opt/bin/codex-acp",
    CodexBinary: "/usr/local/bin/codex",
    NodeBinary: "/opt/node-22/bin/node",
    // Round-tripped like every other field. `StationTokens` is what made Config
    // non-comparable, so the check below is DeepEqual rather than `!=` — which is also
    // the honest comparison for a struct that now contains a slice.
    StationTokens: []StationToken{{StationID: "station_9", Path: "/run/agentpod/chotu.jwt"}},
  }
  if err := Save(p, want); err != nil { t.Fatal(err) }
  got, err := Load(p)
  if err != nil { t.Fatal(err) }
  if !reflect.DeepEqual(got, want) { t.Fatalf("got %+v want %+v", got, want) }
}
