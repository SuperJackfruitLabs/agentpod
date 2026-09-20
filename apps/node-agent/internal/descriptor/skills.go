package descriptor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

// SkillInventoryProvider is optional. Inventory grants no installation, refresh,
// lifecycle or product-operation authority.
type SkillInventoryProvider interface {
	SkillInventory(context.Context, string) (skills.Inventory, error)
}

func localSkillInventory(ctx context.Context, d Descriptor, key string, roots []skills.RootSpec) (skills.Inventory, error) {
	if err := ctx.Err(); err != nil {
		return skills.Inventory{}, err
	}
	stations, err := d.Detect()
	if err != nil {
		return skills.Inventory{}, err
	}
	// Match the complete detected key. Never join a caller's profile suffix to a
	// filesystem path; doing so would allow traversal and undiscovered profiles.
	for _, station := range stations {
		if station.Key == key && station.WorkspacePath != nil {
			return skills.Scan(ctx, key, d.Harness(), *station.WorkspacePath, roots)
		}
	}
	return skills.Inventory{}, fmt.Errorf("skills.inventory: station is not currently detected")
}
func (d *codexDescriptor) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	return localSkillInventory(ctx, d, key, []skills.RootSpec{{RelativePath: ".agents/skills", Scope: "workspace"}})
}
func (d *claudeCodeDescriptor) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	return localSkillInventory(ctx, d, key, []skills.RootSpec{{RelativePath: ".claude/skills", Scope: "workspace"}})
}
func (d *openCodeDescriptor) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	return localSkillInventory(ctx, d, key, []skills.RootSpec{{RelativePath: ".opencode/skills", Scope: "workspace"}, {RelativePath: ".agents/skills", Scope: "workspace"}, {RelativePath: ".claude/skills", Scope: "workspace"}})
}
func (d *piDescriptor) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	return localSkillInventory(ctx, d, key, []skills.RootSpec{{RelativePath: ".pi/skills", Scope: "workspace"}, {RelativePath: ".agents/skills", Scope: "workspace"}})
}
func (d *hermesDescriptor) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	return localSkillInventory(ctx, d, key, []skills.RootSpec{{RelativePath: "skills", Scope: "profile"}, {RelativePath: ".hermes/skills", Scope: "workspace"}, {RelativePath: ".agents/skills", Scope: "workspace"}})
}
func (d *openclawDescriptor) SkillInventory(ctx context.Context, key string) (skills.Inventory, error) {
	return localSkillInventory(ctx, d, key, []skills.RootSpec{{RelativePath: "skills", Scope: "workspace"}, {RelativePath: ".agents/skills", Scope: "workspace"}})
}
func handleSkillInventory(ctx context.Context, reg *Registry, params json.RawMessage) (any, bool, error) {
	var p struct {
		Key string `json:"key"`
	}
	decoder := json.NewDecoder(bytes.NewReader(params))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&p); err != nil {
		return nil, false, fmt.Errorf("skills.inventory: invalid params")
	}
	if p.Key == "" || len(p.Key) > 512 || decoder.Decode(new(any)) != io.EOF {
		return nil, false, fmt.Errorf("skills.inventory: invalid params")
	}
	d, err := reg.For(p.Key)
	if err != nil {
		return nil, false, err
	}
	provider, ok := d.(SkillInventoryProvider)
	if !ok {
		return nil, false, fmt.Errorf("skills.inventory: capability unavailable")
	}
	result, err := provider.SkillInventory(ctx, p.Key)
	return result, false, err
}
