package contractfix

import (
	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
	"testing"
)

func TestSkillInventoryRoundTrips(t *testing.T) {
	roundTrip(t, "skill_inventory.json", &skills.Inventory{})
}
