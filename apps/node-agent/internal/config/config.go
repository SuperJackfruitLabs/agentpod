package config

import ("encoding/json"; "os"; "path/filepath")

type Config struct {
  Hub        string `json:"hub"`
  NodeID     string `json:"nodeId"`
  NodeSecret string `json:"nodeSecret"`
  // HermesStartCmd is the shell command used to start the Hermes gateway.
  // Needed by the lifecycle "start" and "restart" actions. Optional.
  HermesStartCmd   string `json:"hermesStartCmd,omitempty"`
  // OpenClawStartCmd is the shell command used to start the OpenClaw gateway.
  // Needed by the lifecycle "start" and "restart" actions. Optional.
  OpenClawStartCmd string `json:"openclawStartCmd,omitempty"`
  // OpenClawGatewayURL / OpenClawTokenFile / OpenClawSessionLabel configure the
  // `openclaw acp` bridge. All optional: with a local Gateway, openclaw resolves
  // its own URL from config. The token is passed as a FILE PATH, never inline —
  // argv is world-readable.
  // OpenClawBinary is the openclaw executable to spawn (absolute path). Optional:
  // when empty the node-agent resolves it from PATH, then from well-known install
  // paths. Set it when openclaw lives somewhere the service's PATH can't see —
  // e.g. a pnpm global install under ~/.local/share/pnpm, invisible to a systemd
  // user service.
  OpenClawBinary       string `json:"openclawBinary,omitempty"`
  OpenClawGatewayURL   string `json:"openclawGatewayUrl,omitempty"`
  OpenClawTokenFile    string `json:"openclawTokenFile,omitempty"`
  OpenClawSessionLabel string `json:"openclawSessionLabel,omitempty"`
  // Claude Code has no native ACP mode: sessions run through the external
  // claude-agent-acp adapter (a Node program). All three keys are optional —
  // with the adapter or npx on PATH, a node needs no configuration.
  //
  // ClaudeCodeAcpBinary is a claude-agent-acp executable, used verbatim as
  // argv[0]; when empty the node-agent resolves it from PATH, then from
  // well-known install paths, then falls back to a version-pinned `npx -y`.
  // ClaudeCodeBinary is the claude CLI exported as CLAUDE_CODE_EXECUTABLE, so
  // the ACP session drives the same install the Health tab reports on.
  // NodeBinary is the node runtime (its directory also supplies npx) for hosts
  // where node isn't on the service's PATH.
  ClaudeCodeAcpBinary string `json:"claudeCodeAcpBinary,omitempty"`
  ClaudeCodeBinary    string `json:"claudeCodeBinary,omitempty"`
  NodeBinary          string `json:"nodeBinary,omitempty"`
}

func DefaultPath() string {
  d, _ := os.UserConfigDir()
  return filepath.Join(d, "agentpod-node", "config.json")
}

func Save(path string, c Config) error {
  if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil { return err }
  b, err := json.MarshalIndent(c, "", "  "); if err != nil { return err }
  return os.WriteFile(path, b, 0o600)
}

func Load(path string) (Config, error) {
  var c Config
  b, err := os.ReadFile(path); if err != nil { return c, err }
  return c, json.Unmarshal(b, &c)
}
