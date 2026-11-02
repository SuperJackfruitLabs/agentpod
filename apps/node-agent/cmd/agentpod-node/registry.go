package main

import (
	"os"
	"os/exec"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/claudecode"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/codex"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hermes"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/kilo"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/muse"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/openclaw"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/opencode"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/pi"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/salaamharness"
)

// buildRegistry constructs the descriptor registry from the node config.
// Every field it reads is optional: the zero Config yields the same registry as
// an unconfigured host (detection works; lifecycle start, the openclaw ACP
// gateway overrides and the claude-code/codex adapter/runtime overrides simply
// stay unset, and each descriptor resolves what it can from the host).
func buildRegistry(cfg config.Config) *descriptor.Registry {
	reg := descriptor.NewRegistry()
	home, _ := os.UserHomeDir()
	reg.Register(salaamharness.NewSalaamFrom(salaamharness.DiscoverSalaam(salaamharness.SalaamConfig{Binary: cfg.SalaamBinary, StateDir: cfg.SalaamStateDir, Workspace: cfg.SalaamWorkspace, NodeBinary: cfg.SalaamNodeBinary, Manifest: cfg.SalaamManifest, NodeID: cfg.NodeID}, home, exec.LookPath)))
	reg.Register(hermes.NewHermes("", cfg.HermesStartCmd))
	reg.Register(openclaw.NewOpenClawFrom(openclaw.OpenClawConfig{
		StartCmd:     cfg.OpenClawStartCmd,
		Binary:       cfg.OpenClawBinary,
		GatewayURL:   cfg.OpenClawGatewayURL,
		TokenFile:    cfg.OpenClawTokenFile,
		SessionLabel: cfg.OpenClawSessionLabel,
	}))
	reg.Register(claudecode.NewClaudeCodeFrom(claudecode.ClaudeCodeConfig{
		AcpBinary:    cfg.ClaudeCodeAcpBinary,
		ClaudeBinary: cfg.ClaudeCodeBinary,
		NodeBinary:   cfg.NodeBinary,
	}))
	reg.Register(opencode.NewOpenCode(""))
	reg.Register(pi.NewPi(""))
	reg.Register(codex.NewCodexFrom(codex.CodexConfig{
		AcpBinary:   cfg.CodexAcpBinary,
		CodexBinary: cfg.CodexBinary,
		NodeBinary:  cfg.NodeBinary,
	}))
	reg.Register(muse.NewMuseFrom(muse.MuseConfig{
		AcpBinary:  cfg.MuseAcpBinary,
		MuseBinary: cfg.MuseBinary,
	}))
	reg.Register(kilo.NewKiloFrom(kilo.KiloConfig{
		DataDir: cfg.KiloDataDir,
		Binary:  cfg.KiloBinary,
	}))
	if cfg.ConfigManagement {
		reg.EnableConfigManagement()
	}
	return reg
}
