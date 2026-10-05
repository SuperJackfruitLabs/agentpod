package descriptor

import (
	"context"
	"fmt"
	"os"
	"path/filepath"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/configedit"
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
			// PRESENT, and yamlValue's text scan alone can't say whether it's a
			// list or a nested map — only that nothing scalar follows the colon.
			// A list IS a shape this reader can speak for (configedit.Read sees
			// it structurally), and `approvals.command_allowlist` is exactly
			// that shape in every real document: reporting it unreadable was a
			// false negative, making a declared, present key look absent-ish to
			// every caller that only sees Readable:false. A nested map is not a
			// registered setting's shape today and stays unreadable.
			list, listErr := observedList(data, where[0]+"."+where[1])
			switch {
			case listErr != nil:
				cv.Readable = false
				cv.Reason = fmt.Sprintf(
					"%s.%s is present in %s but could not be read: %v",
					where[0], where[1], path, listErr,
				)
			case list != nil:
				cv.Observed = list
			default:
				// Present, and a nested map — not a shape this reader can speak
				// for. Reported as unreadable, never as absent: "the key is not
				// in the document" would be a false sentence about a document
				// that plainly contains it.
				cv.Readable = false
				cv.Reason = fmt.Sprintf(
					"%s.%s is present in %s but holds a nested map; this reader reports scalars and lists only",
					where[0], where[1], path,
				)
			}
		case yamlAbsent:
			// Readable, with no value: the caller decides what an absent key means.
		}
		out = append(out, cv)
	}
	return out, nil
}

// observedList reports what configedit.Read saw at keyPath, but only when it
// is a list: ([]any, nil) for a present sequence, (nil, nil) for anything
// else present (a nested map, or absent — callers only reach this from a
// yamlNotScalar result, so it is always present), or (nil, err) if the
// document could not be re-parsed. It never returns a scalar: ObserveConfig's
// own yamlValue path already owns scalars, and this is only consulted when
// that path found something non-scalar.
func observedList(data []byte, keyPath string) ([]any, error) {
	v, present, err := configedit.Read(data, keyPath)
	if err != nil {
		return nil, err
	}
	if !present {
		return nil, nil
	}
	list, ok := v.([]any)
	if !ok {
		return nil, nil
	}
	return list, nil
}
