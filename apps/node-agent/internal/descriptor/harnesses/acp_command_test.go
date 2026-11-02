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

// --- capability advertising ---

func TestCapabilitiesIncludeACP(t *testing.T) {
	t.Run("opencode", func(t *testing.T) {
		dataDir, _ := buildOpenCodeFixture(t)
		assertAllStationsHaveACP(t, opencode.NewOpenCode(dataDir))
	})
	t.Run("hermes", func(t *testing.T) {
		assertAllStationsHaveACP(t, hermes.NewHermes(testdataHermesHome(t)))
	})
	t.Run("openclaw", func(t *testing.T) {
		assertAllStationsHaveACP(t, openclaw.NewOpenClaw(testdataOpenClawHome(t)))
	})
	t.Run("claude-code", func(t *testing.T) {
		home, _, _, _ := buildClaudeCodeFixture(t)
		assertAllStationsHaveACP(t, claudecode.NewClaudeCode(home))
	})
	t.Run("codex", func(t *testing.T) {
		home, _, _ := buildCodexFixture(t)
		assertAllStationsHaveACP(t, codex.NewCodex(home))
	})
	// Pi is the one harness whose "acp" capability is CONDITIONAL: it rides on
	// the external pi-acp adapter resolving, so the stub has to be on PATH
	// before Detect runs or this subtest fails for a reason that has nothing to
	// do with the conformance it is here to check. The gating itself is
	// asserted by TestPiACPCapabilityGatedOnAdapter.
	t.Run("pi", func(t *testing.T) {
		dataDir, _ := buildPiFixture(t)
		writePiACPStub(t)
		assertAllStationsHaveACP(t, pi.NewPi(dataDir))
	})
}

func assertAllStationsHaveACP(t *testing.T, d descriptor.Descriptor) {
	t.Helper()
	stations, err := d.Detect()
	if err != nil {
		t.Fatalf("Detect: %v", err)
	}
	if len(stations) == 0 {
		t.Fatal("fixture produced no stations")
	}
	for _, s := range stations {
		var found bool
		for _, c := range s.Capabilities {
			if c == "acp" {
				found = true
			}
		}
		if !found {
			t.Errorf("station %q missing %q capability: %v", s.Key, "acp", s.Capabilities)
		}
	}
}
