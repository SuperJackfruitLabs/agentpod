package pi

import (
	"context"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
)

func (d *Descriptor) ManagedSkillWorkspace(ctx context.Context, key string) (string, error) {
	return descriptor.LocalManagedSkillWorkspace(ctx, d, key)
}
