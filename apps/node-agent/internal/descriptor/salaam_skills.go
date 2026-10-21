package descriptor

import (
	"context"
	"fmt"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

func (s *salaamDescriptor) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	if !s.configured() {
		return skills.Inventory{}, fmt.Errorf("salaam: private station is not configured")
	}
	return s.client().SkillInventory(ctx, key)
}
