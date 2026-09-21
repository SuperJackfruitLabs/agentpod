package descriptor

import (
	"context"
	"fmt"
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

// NativeSkillReadinessProvider is optional. A provider must resolve the
// station key itself and describe the runtime it would actually launch.
// Readiness does not authorize a publication: external-process quiescence and
// session restart remain separate gates.
type NativeSkillReadinessProvider interface {
	NativeSkillReadiness(context.Context, string) (NativeSkillReadiness, error)
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
