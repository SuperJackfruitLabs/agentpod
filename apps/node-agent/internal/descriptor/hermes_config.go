package descriptor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// hermesConfigRegistry is the whole set of Hermes settings this system manages.
//
// A list, not a pattern (spec D1). `approvals.*` is here because a prompt that
// expires before a human can answer is what this design came from; everything
// else Hermes has stays the operator's, reachable through the raw Config panel.
//
// Every entry assumes a restart is needed. Hermes documents hot-reload for
// `model.context_length` and `compression.*` and a restart for "API keys and
// tool/skill config"; `approvals.*` is in neither list, so this is UNVERIFIED and
// the safe direction is to assume yes — see spec §7.
var hermesConfigRegistry = []ConfigSetting{
	{ID: "hermes.approvals.timeout", Harness: "hermes", Scope: "profile", Policy: "reconcilable", RestartToTakeEffect: true},
	{ID: "hermes.approvals.mode", Harness: "hermes", Scope: "profile", Policy: "reconcilable", RestartToTakeEffect: true},
	{ID: "hermes.approvals.command_allowlist", Harness: "hermes", Scope: "profile", Policy: "additive-only", RestartToTakeEffect: true},
}

// hermesConfigPath maps a registered setting id to the YAML section and key it
// lives under. Separate from the registry because the registry is the wire
// contract and this is how to find the value — two different facts.
var hermesConfigPath = map[string][2]string{
	"hermes.approvals.timeout":           {"approvals", "timeout"},
	"hermes.approvals.mode":              {"approvals", "mode"},
	"hermes.approvals.command_allowlist": {"approvals", "command_allowlist"},
}

func (h *hermesDescriptor) ConfigSettings() []ConfigSetting {
	out := make([]ConfigSetting, len(hermesConfigRegistry))
	copy(out, hermesConfigRegistry)
	return out
}

func (h *hermesDescriptor) ObserveConfig(ctx context.Context, key string, settings []string) ([]ConfigValue, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	// Refuse the whole request on an unregistered id rather than returning a
	// partial answer: a caller that asked for four settings and silently got
	// three cannot tell which.
	for _, id := range settings {
		if _, ok := hermesConfigPath[id]; !ok {
			return nil, fmt.Errorf("config: %s is not a setting this harness manages", id)
		}
	}

	// workspaceFor is the EXISTING key→directory resolver (hermes.go). A second
	// one is how two readers come to disagree about which profile a station is.
	//
	// It returns h.home for the bare key "hermes" — the COMPOSITE root, which has
	// no profile of its own. A profile-scoped setting declared against the root is
	// refused rather than read from the home or fanned out to every child
	// (spec §6).
	if key == "hermes" {
		return nil, fmt.Errorf("config: %s is the composite root, which has no profile of its own — declare this per profile, or at node or fleet level", key)
	}
	dir, err := h.workspaceFor(key)
	if err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "config.yaml")
	data, readErr := os.ReadFile(path)

	out := make([]ConfigValue, 0, len(settings))
	for _, id := range settings {
		if readErr != nil {
			// Unreadable, which is NOT the same as a key that is absent.
			out = append(out, ConfigValue{SettingID: id, Readable: false, Reason: readErr.Error()})
			continue
		}
		where := hermesConfigPath[id]
		v, state := yamlValue(data, where[0], where[1])
		cv := ConfigValue{SettingID: id, Readable: true}
		switch state {
		case yamlScalarValue:
			cv.Observed = v
		case yamlNotScalar:
			// PRESENT, and not a shape this reader can speak for — a list or a
			// nested map. Reported as unreadable, never as absent: "the key is
			// not in the document" would be a false sentence about a document
			// that contains it, and handing back an inline list's raw text
			// would compare as drift forever.
			//
			// `approvals.command_allowlist` is the one registered setting this
			// reaches today. It stays registered — a later plan needs it — and
			// the limitation is stated here rather than hidden behind a wrong
			// state.
			cv.Readable = false
			cv.Reason = fmt.Sprintf(
				"%s.%s is present in %s but holds a list or a nested map; this reader reports scalars only",
				where[0], where[1], path,
			)
		case yamlAbsent:
			// Readable, with no value: the caller decides what an absent key means.
		}
		out = append(out, cv)
	}
	return out, nil
}
