package main

import (
	"github.com/rakeshgangwar/agentpod/node-agent/internal/config"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

// buildRegistry constructs the descriptor registry from the node config.
// Every field it reads is optional: the zero Config yields the same registry as
// an unconfigured host (detection works; lifecycle start, the openclaw ACP
// gateway overrides and the claude-code adapter/runtime overrides simply stay
// unset, and each descriptor resolves what it can from the host).
func buildRegistry(cfg config.Config) *descriptor.Registry {
	reg := descriptor.NewRegistry()
	reg.Register(descriptor.NewHermes("", cfg.HermesStartCmd))
	reg.Register(descriptor.NewOpenClawFrom(descriptor.OpenClawConfig{
		StartCmd:     cfg.OpenClawStartCmd,
		Binary:       cfg.OpenClawBinary,
		GatewayURL:   cfg.OpenClawGatewayURL,
		TokenFile:    cfg.OpenClawTokenFile,
		SessionLabel: cfg.OpenClawSessionLabel,
	}))
	reg.Register(descriptor.NewClaudeCodeFrom(descriptor.ClaudeCodeConfig{
		AcpBinary:    cfg.ClaudeCodeAcpBinary,
		ClaudeBinary: cfg.ClaudeCodeBinary,
		NodeBinary:   cfg.NodeBinary,
	}))
	reg.Register(descriptor.NewOpenCode(""))
	reg.Register(descriptor.NewCodex(""))
	return reg
}
