package hermes

import (
	"context"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/hermeslive"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

func (d *Descriptor) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	inventory, err := descriptor.LocalSkillInventory(ctx, d, key, []skills.RootSpec{{RelativePath: "skills", Scope: "profile"}, {RelativePath: ".hermes/skills", Scope: "workspace"}, {RelativePath: ".agents/skills", Scope: "workspace"}})
	if err != nil {
		return inventory, err
	}
	// The agentpod-live plugin is reported beside the skills (#553) whenever it
	// is in the profile or apn has a record of installing it: its files, whether
	// the configuration enables it, and what the gateway's log says of its load
	// and last turn. The key was matched against a detected station above.
	if dir, err := d.workspaceFor(key); err == nil {
		if plugin, st := hermeslive.Observe(dir, time.Now()); st.Present || st.Managed {
			inventory.Plugins = append(inventory.Plugins, plugin)
		}
	}
	return inventory, nil
}
