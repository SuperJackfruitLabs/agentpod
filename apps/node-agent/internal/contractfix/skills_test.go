package contractfix

import (
	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
	"testing"
)

func TestSkillInventoryRoundTrips(t *testing.T) {
	roundTrip(t, "skill_inventory.json", &skills.Inventory{})
}

func TestSkillInstallRoundTrips(t *testing.T) {
	roundTrip(t, "skill_install_plan.json", &skills.InstallPlan{})
	roundTrip(t, "skill_install_receipt.json", &skills.InstallReceipt{})
}

func TestSkillPlacementRoundTrips(t *testing.T) {
	roundTrip(t, "skill_placement_plan.json", &skills.PlacementPlan{})
	roundTrip(t, "skill_placement_receipt.json", &skills.PlacementReceipt{})
}
