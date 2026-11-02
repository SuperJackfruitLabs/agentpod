package hermes

import (
	"testing"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

func TestHermesDescriptorStillSatisfiesConfigManager(t *testing.T) {
	var d descriptor.Descriptor = NewHermes(t.TempDir())
	if _, ok := d.(descriptor.ConfigManager); !ok {
		t.Fatal("the Hermes descriptor must implement ConfigManager, or config.manage silently never appears for any Hermes station")
	}
}
