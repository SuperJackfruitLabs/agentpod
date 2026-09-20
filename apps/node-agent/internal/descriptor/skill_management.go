package descriptor

import (
	"context"
	"fmt"
	"path/filepath"
)

// SkillManagementProvider is optional and only grants access to managed package
// storage. It does not promise native plugin registration or session activation.
type SkillManagementProvider interface {
	ManagedSkillWorkspace(context.Context, string) (string, error)
}

func localManagedSkillWorkspace(ctx context.Context, d Descriptor, key string) (string, error) {
	if err := ctx.Err(); err != nil {
		return "", err
	}
	stations, err := d.Detect()
	if err != nil {
		return "", err
	}
	for _, station := range stations {
		if station.Key == key && station.WorkspacePath != nil && filepath.IsAbs(*station.WorkspacePath) {
			return *station.WorkspacePath, ctx.Err()
		}
	}
	return "", fmt.Errorf("skills: station workspace is not currently detected")
}

// EnableSkillManagement is called at startup, before serving requests, only
// after the authenticated download transport and management handler exist.
func (r *Registry) EnableSkillManagement() { r.skillManagement = true }

func (r *Registry) ManagedSkillWorkspace(ctx context.Context, key string) (string, string, error) {
	if !r.skillManagement {
		return "", "", fmt.Errorf("skills: management is not configured")
	}
	d, err := r.For(key)
	if err != nil {
		return "", "", err
	}
	provider, ok := d.(SkillManagementProvider)
	if !ok {
		return "", "", fmt.Errorf("skills: management is unavailable for this harness")
	}
	workspace, err := provider.ManagedSkillWorkspace(ctx, key)
	return workspace, d.Harness(), err
}

func (d *codexDescriptor) ManagedSkillWorkspace(ctx context.Context, key string) (string, error) {
	return localManagedSkillWorkspace(ctx, d, key)
}
func (d *claudeCodeDescriptor) ManagedSkillWorkspace(ctx context.Context, key string) (string, error) {
	return localManagedSkillWorkspace(ctx, d, key)
}
func (d *openCodeDescriptor) ManagedSkillWorkspace(ctx context.Context, key string) (string, error) {
	return localManagedSkillWorkspace(ctx, d, key)
}
func (d *piDescriptor) ManagedSkillWorkspace(ctx context.Context, key string) (string, error) {
	return localManagedSkillWorkspace(ctx, d, key)
}
func (d *hermesDescriptor) ManagedSkillWorkspace(ctx context.Context, key string) (string, error) {
	return localManagedSkillWorkspace(ctx, d, key)
}
func (d *openclawDescriptor) ManagedSkillWorkspace(ctx context.Context, key string) (string, error) {
	return localManagedSkillWorkspace(ctx, d, key)
}
