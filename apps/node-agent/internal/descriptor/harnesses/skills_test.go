package harnesses

import (
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/claudecode"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/codex"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/hermes"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/openclaw"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/opencode"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/pi"
)

func TestAllSkillInventoryDescriptorsImplementOptionalInterface(t *testing.T) {
	home := t.TempDir()
	for _, d := range []descriptor.Descriptor{hermes.NewHermes(home), openclaw.NewOpenClaw(home), codex.NewCodex(home), claudecode.NewClaudeCode(home), opencode.NewOpenCode(home), pi.NewPi(home)} {
		if _, ok := d.(descriptor.SkillInventoryProvider); !ok {
			t.Fatalf("%s lacks its advertised provider", d.Harness())
		}
	}
}
