package descriptor

import (
	"context"
	"fmt"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/skills"
)

// NativeSkillReadiness is evidence about a new session's native discovery
// runtime. It deliberately says nothing about an already-running process.
type NativeSkillReadiness struct {
	Harness        string `json:"harness"`
	Ready          bool   `json:"ready"`
	Reason         string `json:"reason"`
	AdapterPath    string `json:"adapterPath,omitempty"`
	AdapterVersion string `json:"adapterVersion,omitempty"`
	EngineVersion  string `json:"engineVersion,omitempty"`
}

// NativeSkillLoadingProvider runs a harness-specific, fresh-session check over
// the exact names a native placement expects. It is observational: it does not
// modify a station, prompt a model or refresh an existing user session.
type NativeSkillLoadingProvider interface {
	NativeSkillLoading(context.Context, string, []string) (skills.Observation, error)
}

// NativeSkillReadinessProvider is optional. A provider must resolve the
// station key itself and describe the runtime it would actually launch.
// Readiness does not authorize a publication: external-process quiescence and
// session restart remain separate gates.
type NativeSkillReadinessProvider interface {
	NativeSkillReadiness(context.Context, string) (NativeSkillReadiness, error)
}

func (r *Registry) NativeSkillLoading(ctx context.Context, key string, names []string) (skills.Observation, error) {
	d, err := r.For(key)
	if err != nil {
		return skills.Observation{}, err
	}
	p, ok := d.(NativeSkillLoadingProvider)
	if !ok {
		return skills.Observation{Reason: "Fresh native loading verification is not implemented for this harness"}, nil
	}
	result, err := p.NativeSkillLoading(ctx, key, names)
	if err != nil {
		return skills.Observation{}, err
	}
	if result.Reason == "" || (result.Value != nil && result.ObservedAt == nil) {
		return skills.Observation{}, fmt.Errorf("native skills: invalid loading result")
	}
	return result, nil
}

func observedNativeSkillLoading(value bool, reason string) skills.Observation {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	return skills.Observation{Value: &value, ObservedAt: &now, Reason: reason}
}

func (r *Registry) NativeSkillReadiness(ctx context.Context, key string) (NativeSkillReadiness, error) {
	d, err := r.For(key)
	if err != nil {
		return NativeSkillReadiness{}, err
	}
	p, ok := d.(NativeSkillReadinessProvider)
	if !ok {
		return NativeSkillReadiness{Harness: d.Harness(), Reason: "Native runtime readiness is not implemented for this harness"}, nil
	}
	result, err := p.NativeSkillReadiness(ctx, key)
	if err != nil {
		return NativeSkillReadiness{}, err
	}
	if result.Harness != d.Harness() || result.Reason == "" {
		return NativeSkillReadiness{}, fmt.Errorf("native skills: invalid readiness result")
	}
	return result, nil
}

// nativeSkillInventoryReporter is implemented by a harness that can say which
// skill names it already holds. Only some can: Codex, Claude, OpenCode and Pi
// are asked to open a session and do not enumerate a stable inventory, while
// Hermes and OpenClaw print one on demand.
type nativeSkillInventoryReporter interface {
	NativeSkillInventory(ctx context.Context, key string) (map[string]string, error)
}

// NativeSkillInventory returns the harness's own account of which skill names
// exist, or nil when this harness cannot give one.
//
// A nil inventory and a nil error mean "cannot report", and the caller keeps
// walking the workspace. That is deliberately distinct from an error, which
// means the harness could have answered and did not -- placement must refuse
// on the second and fall back on the first.
func (r *Registry) NativeSkillInventory(ctx context.Context, key string) (map[string]string, error) {
	d, err := r.For(key)
	if err != nil {
		return nil, err
	}
	reporter, ok := d.(nativeSkillInventoryReporter)
	if !ok {
		return nil, nil
	}
	return reporter.NativeSkillInventory(ctx, key)
}
