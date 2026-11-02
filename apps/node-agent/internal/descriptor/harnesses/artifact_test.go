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

func TestSixDescriptorsAreWorkspaceRooters(t *testing.T) {
	for name, d := range map[string]any{
		"hermes": &hermes.Descriptor{}, "claudecode": &claudecode.Descriptor{}, "codex": &codex.Descriptor{},
		"openclaw": &openclaw.Descriptor{}, "opencode": &opencode.Descriptor{}, "pi": &pi.Descriptor{},
	} {
		if _, ok := d.(descriptor.WorkspaceRooter); !ok {
			t.Errorf("%s must implement WorkspaceRooter", name)
		}
	}
}

func mustOK(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
