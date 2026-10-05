package descriptor

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

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

// isCompositeRootKey reports whether key names the composite root rather
// than a profile — the same question isCompositeRoot answers about a
// Station, resolved from a key by finding that station through Detect. This
// goes through the real Station (Kind AND ParentKey), not a bare `key ==
// "hermes"` string compare, so it stays correct if a composite harness ever
// grows a root key other than "hermes".
func (h *hermesDescriptor) isCompositeRootKey(key string) (bool, error) {
	stations, err := h.Detect()
	if err != nil {
		return false, err
	}
	for _, s := range stations {
		if s.Key == key {
			return isCompositeRoot(s), nil
		}
	}
	return false, nil
}

// PlanConfig derives, in memory only, the edit that would satisfy `want` on
// the profile named by key. It writes nothing to disk; see config_plan.go
// for the shapes and configedit for the read/edit primitives this composes.
//
// Checks run in this order, each its own refusal:
//
//  1. CREDENTIAL_PATH — before the document is read at all.
//  2. OUT_OF_SCOPE — the composite root has no profile document of its own.
//  3. UNKNOWN_SETTING — any requested id this harness does not register.
//  4. UNREADABLE — the document does not parse as YAML.
//  5. Per setting, by policy (reconcilable: SetScalar; additive-only:
//     AppendToList; report-only: always a noop).
//  6. SHAPE_UNEXPECTED — configedit.SameOutsideKeys found a change outside
//     the keys this plan claims to touch.
func (h *hermesDescriptor) PlanConfig(ctx context.Context, key, operationID string, want []DeclaredSetting) (ConfigPlan, error) {
	if err := ctx.Err(); err != nil {
		return ConfigPlan{}, err
	}

	plan := ConfigPlan{
		SchemaVersion: 1,
		OperationID:   operationID,
		StationKey:    key,
		Entries:       []ConfigPlanEntry{},
		CreatedAt:     time.Now().UTC().Format(time.RFC3339),
	}
	refuse := func(code, message string) (ConfigPlan, error) {
		plan.Refusal = &ConfigRefusal{Code: code, Message: message}
		plan.PlanDigest = configDigestOf(plan)
		return plan, nil
	}

	// 1. Resolve the document this key's settings live in, and refuse a
	// credential path before reading anything. Every Hermes setting
	// registered today resolves to config.yaml, so this cannot fire through
	// production data — see isCredentialPath's comment — but the check still
	// runs first, ahead of every other check, so a future setting that DOES
	// resolve elsewhere is never opened even once.
	dir, err := h.workspaceFor(key)
	if err != nil {
		return ConfigPlan{}, err
	}
	path := filepath.Join(dir, "config.yaml")
	if isCredentialPath(path) {
		return refuse("CREDENTIAL_PATH", fmt.Sprintf("%s names a credential file and will not be read or edited", path))
	}

	// 2. The composite root has no profile-scoped document of its own
	// (spec §6) — reuse isCompositeRoot rather than re-deriving the rule.
	root, err := h.isCompositeRootKey(key)
	if err != nil {
		return ConfigPlan{}, err
	}
	if root {
		return refuse("OUT_OF_SCOPE", fmt.Sprintf(
			"%s is the composite root, which has no profile-scoped document of its own — declare this per profile, or at node or fleet level", key))
	}

	// 3. Every requested id must be registered, named if not.
	byID := make(map[string]ConfigSetting, len(hermesConfigRegistry))
	for _, s := range hermesConfigRegistry {
		byID[s.ID] = s
	}
	for _, d := range want {
		if _, ok := byID[d.SettingID]; !ok {
			return refuse("UNKNOWN_SETTING", fmt.Sprintf("%s is not a setting this harness manages", d.SettingID))
		}
	}

	// 4. Read and parse the document.
	before, err := os.ReadFile(path)
	if err != nil {
		return refuse("UNREADABLE", fmt.Sprintf("%s could not be read: %v", path, err))
	}
	// configedit.Read's only failure modes are the document not parsing as
	// YAML at all, or a present leaf that cannot decode — either way the
	// document, not any one setting, is what is unreadable.
	if _, _, err := configedit.Read(before, "approvals.timeout"); err != nil {
		return refuse("UNREADABLE", fmt.Sprintf("%s is not valid YAML: %v", path, err))
	}

	after := before
	entries := make([]ConfigPlanEntry, 0, len(want))
	keyPaths := make([]string, 0, len(want))
	additive := map[string][]string{}

	for _, d := range want {
		setting := byID[d.SettingID]
		where := hermesConfigPath[d.SettingID]
		keyPath := where[0] + "." + where[1]
		keyPaths = append(keyPaths, keyPath)

		current, present, err := configedit.Read(after, keyPath)
		if err != nil {
			return refuse("UNREADABLE", fmt.Sprintf("%s is not valid YAML: %v", path, err))
		}
		entry := ConfigPlanEntry{
			SettingID:           d.SettingID,
			File:                path,
			KeyPath:             keyPath,
			Policy:              setting.Policy,
			Intended:            d.Value,
			RestartToTakeEffect: setting.RestartToTakeEffect,
		}
		if present {
			entry.Current = current
		}

		switch setting.Policy {
		case "reconcilable":
			edited, action, err := configedit.SetScalar(after, keyPath, d.Value)
			if err != nil {
				return refuse("SHAPE_UNEXPECTED", fmt.Sprintf("%s: %v", keyPath, err))
			}
			if bytes.Equal(edited, after) {
				action = "noop"
			}
			entry.Action = action
			after = edited

		case "additive-only":
			items, ok := toStringList(d.Value)
			if !ok {
				return refuse("SHAPE_UNEXPECTED", fmt.Sprintf("%s: declared value is not a list of strings", keyPath))
			}
			edited, action, added, err := configedit.AppendToList(after, keyPath, items)
			if err != nil {
				return refuse("SHAPE_UNEXPECTED", fmt.Sprintf("%s: %v", keyPath, err))
			}
			entry.Action = action
			after = edited
			if len(added) > 0 {
				additive[keyPath] = append(additive[keyPath], added...)
			}
			merged, _, rerr := configedit.Read(after, keyPath)
			if rerr != nil {
				return refuse("UNREADABLE", fmt.Sprintf("%s is not valid YAML: %v", path, rerr))
			}
			entry.Intended = merged

		case "report-only":
			// Never written, by definition — the declared value is reported,
			// not applied, so there is nothing to compare for a mismatch.
			entry.Action = "noop"
			entry.Intended = entry.Current

		default:
			return ConfigPlan{}, fmt.Errorf("config: %s has an unrecognized policy %q", d.SettingID, setting.Policy)
		}

		entries = append(entries, entry)
	}

	// 6. The derived edit must change nothing outside the keys this plan
	// claims to touch.
	if err := configedit.SameOutsideKeys(before, after, keyPaths, additive); err != nil {
		return refuse("SHAPE_UNEXPECTED", err.Error())
	}

	plan.Entries = entries
	plan.BeforeSHA256 = sha256Hex(before)
	plan.Diff, plan.DiffTruncated = buildDiff(before, after)

	noOp := true
	restart := false
	for _, e := range entries {
		if e.Action != "noop" {
			noOp = false
			if e.RestartToTakeEffect {
				restart = true
			}
		}
	}
	plan.NoOp = noOp
	plan.RestartRequired = restart

	plan.PlanDigest = configDigestOf(plan)
	return plan, nil
}
