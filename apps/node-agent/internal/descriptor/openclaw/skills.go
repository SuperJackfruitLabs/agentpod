package openclaw

import (
	"context"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

func (d *Descriptor) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	return descriptor.LocalSkillInventory(ctx, d, key, []skills.RootSpec{{RelativePath: "skills", Scope: "workspace"}, {RelativePath: ".agents/skills", Scope: "workspace"}})
}
