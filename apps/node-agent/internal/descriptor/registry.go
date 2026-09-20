package descriptor

import (
	"fmt"
	"path/filepath"
	"strings"
)

// Registry maps harness names to Descriptor implementations.
type Registry struct {
	descriptors     map[string]Descriptor
	skillManagement bool
}

// NewRegistry returns an empty Registry.
func NewRegistry() *Registry {
	return &Registry{descriptors: make(map[string]Descriptor)}
}

// Register adds d to the registry keyed by d.Harness(). Replaces any existing
// entry for the same harness.
func (r *Registry) Register(d Descriptor) {
	r.descriptors[d.Harness()] = d
}

// DetectAll aggregates station discovery across all registered descriptors.
// Errors from individual descriptors are silently skipped so a single broken
// harness does not prevent others from reporting their stations.
func (r *Registry) DetectAll() []Station {
	var all []Station
	for _, d := range r.descriptors {
		stations, err := d.Detect()
		if err == nil {
			_, managed := d.(SkillManagementProvider)
			for _, station := range stations {
				if r.skillManagement && managed && station.WorkspacePath != nil && filepath.IsAbs(*station.WorkspacePath) {
					station.Capabilities = append(append([]string(nil), station.Capabilities...), "skills.manage")
				}
				all = append(all, station)
			}
		}
	}
	return all
}

// For resolves the Descriptor responsible for key.
//
// Keys follow the form "<harness>:<id>" (e.g. "hermes:coder-kai"). A bare
// harness name (e.g. "hermes") is also accepted. The harness segment is
// extracted as everything before the first ':'.
func (r *Registry) For(key string) (Descriptor, error) {
	harness := key
	if idx := strings.Index(key, ":"); idx >= 0 {
		harness = key[:idx]
	}
	d, ok := r.descriptors[harness]
	if !ok {
		return nil, fmt.Errorf("descriptor: no harness registered for %q (key=%q)", harness, key)
	}
	return d, nil
}
