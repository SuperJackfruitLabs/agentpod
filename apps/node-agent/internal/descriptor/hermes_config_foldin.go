package descriptor

import (
	"errors"
	"fmt"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/configedit"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/hermeslive"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/hermesskills"
)

// Three Hermes settings are written today only by `apn` verbs: `apn
// hermes-live` writes `plugins.enabled` and `plugins.stream_reasoning_deltas`,
// and `apn hermes-skills` writes `skills.external_dirs`. This file makes them
// declarable through the registry by CALLING those same writers.
//
// D12 is the whole of it. A folded-in setting delegates; it does not
// reimplement the edit, and it does not become the new home of the logic
// while the verb becomes a wrapper. Both callers stay. The acceptance test is
// byte-identical output to the verb on the same fixture
// (hermes_config_foldin_test.go) — not equivalent YAML, identical bytes,
// because D5's claim is that an operator's formatting survives a write and
// equivalence would not test that at all. A delegation that could not produce
// identical bytes would be abandoned, not reconciled.
//
// Why this is not configedit's job: configedit is a general one-key editor,
// and routing these three through it would be a second implementation of an
// edit that has already been reviewed, shipped and relied on — which is
// exactly how the registry's bytes and the verb's bytes would come to differ
// by a trailing newline nobody noticed.

// hermesDelegate names which reviewed writer owns a folded-in setting.
type hermesDelegate int

const (
	// delegateNone: a setting derivePlanConfig edits through configedit, the
	// way every `approvals.*` setting does.
	delegateNone hermesDelegate = iota
	// delegatePluginEnablement: `hermeslive.PlanEnableConfig`, which writes
	// plugins.enabled AND plugins.stream_reasoning_deltas as ONE edit. It is
	// one writer for two settings on purpose: reasoning deltas reach a plugin
	// only with that flag, so enabling the plugin without it produces a
	// plugin that loads and reports nothing. Splitting it here would be the
	// reimplementation D12 forbids.
	delegatePluginEnablement
	// delegateSkillsExternalDirs: `hermesskills.RegisterIn`, one directory at
	// a time, additively.
	delegateSkillsExternalDirs
)

// hermesConfigDelegate maps a folded-in setting id to its writer. A setting
// absent here is not folded in and goes through configedit; a setting absent
// from hermesConfigRegistry is refused by name before this is consulted (D1).
var hermesConfigDelegate = map[string]hermesDelegate{
	"hermes.plugins.enabled":                 delegatePluginEnablement,
	"hermes.plugins.stream_reasoning_deltas": delegatePluginEnablement,
	"hermes.skills.external_dirs":            delegateSkillsExternalDirs,
}

// pluginsEnabledKey and streamDeltasKey are the two keys the plugin writer
// touches, named once so that every place that has to account for both —
// containment, the plan's key paths — reads from the same pair.
const (
	pluginsEnabledKey = "plugins.enabled"
	streamDeltasKey   = "plugins.stream_reasoning_deltas"
)

// hermesDelegationState is what ONE derivation remembers across the settings
// it is deriving. The plugin pair is written by one indivisible writer, so
// declaring both settings together must run it once — running it twice would
// be harmless (it is idempotent) but would claim the same addition twice in
// the additive bookkeeping, and an over-claimed addition is one of F2's
// sixteen attack shapes.
type hermesDelegationState struct {
	pluginsRan      bool
	pluginsChange   hermeslive.ConfigChange
	pluginsAddition bool // whether this derivation has already claimed the enabled-list addition
}

// delegatedEdit is one folded-in setting's contribution to a plan.
type delegatedEdit struct {
	// doc is the document after the delegated writer ran — the bytes, not a
	// description of them.
	doc []byte
	// action is THIS entry's own action: what happened at its own key, not
	// what the delegated writer did overall.
	action string
	// intended is what this entry reports as intended: the merged list for an
	// additive setting (so ApplyConfig's re-derivation re-declares something
	// the writer can still produce), the declared value otherwise.
	intended any
	// keyPaths is every key the delegated writer may have touched, which for
	// the plugin pair is BOTH keys regardless of which one was declared.
	// Containment is checked against this, so a key the writer touches must
	// be named here or an honest edit would be refused as a shape change.
	keyPaths []string
	// additive names, per key path, the entries this edit claims to have
	// added — never more. A key present with no items is the strictest case,
	// not a skipped one (see configedit.SameOutsideKeys).
	additive map[string][]string

	refusalCode string
	refusalMsg  string
}

func refused(code, format string, args ...any) delegatedEdit {
	return delegatedEdit{refusalCode: code, refusalMsg: fmt.Sprintf(format, args...)}
}

// delegatedConfigEdit derives one folded-in setting's edit by calling the
// writer that owns it. It writes nothing: like every other branch of
// derivePlanConfig it returns bytes, and only ApplyConfig puts them on disk.
//
// A refusal comes back in the returned value rather than as an error, because
// a refused plan is an answer. `hermesskills.ErrConflict` and
// `hermeslive.ErrConflict` — a document shape the reviewed writer will not
// edit — become SHAPE_UNEXPECTED with the writer's own sentence.
// `hermeslive.ErrDisabledByOperator` becomes OPTED_OUT: that is the operator
// speaking through Hermes' own `plugins.disabled`, agentpod never writes that
// list, and enabling must not override it. Those meanings are
// hermeslive/config.go's and are not restated or widened here.
func (h *hermesDescriptor) delegatedConfigEdit(state *hermesDelegationState, doc []byte, d DeclaredSetting, keyPath string) delegatedEdit {
	switch hermesConfigDelegate[d.SettingID] {
	case delegateSkillsExternalDirs:
		return delegateExternalDirs(doc, d, keyPath)
	case delegatePluginEnablement:
		return delegatePlugins(state, doc, d, keyPath)
	default:
		// Unreachable: the caller consults hermesConfigDelegate first.
		return refused("SHAPE_UNEXPECTED", "%s has no delegated writer", d.SettingID)
	}
}

// delegateExternalDirs adds each declared directory through
// hermesskills.RegisterIn — the same function `apn hermes-skills register`
// reaches through hermesskills.Register, which shares its implementation.
//
// One call per directory, each on the document the previous one produced, so
// a declaration of several directories is the verb run several times rather
// than a bulk edit this file would have had to invent.
func delegateExternalDirs(doc []byte, d DeclaredSetting, keyPath string) delegatedEdit {
	items, ok := toStringList(d.Value)
	if !ok {
		return refused("SHAPE_UNEXPECTED", "%s: declared value is not a list of strings", keyPath)
	}
	out := delegatedEdit{
		doc:      doc,
		action:   "noop",
		keyPaths: []string{keyPath},
		additive: map[string][]string{keyPath: {}},
	}
	var added []string
	seen := map[string]bool{}
	for _, dir := range items {
		if seen[dir] {
			continue
		}
		seen[dir] = true
		edited, change, err := hermesskills.RegisterIn(out.doc, dir)
		if err != nil {
			return refused("SHAPE_UNEXPECTED", "%s: %v", keyPath, err)
		}
		if !change.NoOp {
			added = append(added, dir)
		}
		out.doc = edited
	}
	if len(added) > 0 {
		out.action = "append"
	}
	out.additive[keyPath] = added
	merged, _, err := configedit.Read(out.doc, keyPath)
	if err != nil {
		return refused("UNREADABLE", "%s could not be read back after the edit: %v", keyPath, err)
	}
	out.intended = merged
	return out
}

// delegatePlugins derives either plugin setting through
// hermeslive.PlanEnableConfig — the same function `apn hermes-live enable`
// calls.
//
// That writer owns BOTH keys and cannot be asked for half of them, so
// declaring either setting runs it and the plan names both key paths. That is
// not a silent side effect: nothing is written until an operator has reviewed
// the plan's own diff and handed its digest back, and the diff shows every
// line the writer touched. The alternative — teaching this file to write one
// key without the other — is the reimplementation D12 forbids, and it would
// produce a plugin that loads and reports nothing.
//
// The declared value has to be one the writer can actually produce:
//
//   - plugins.enabled may name this plugin and entries the document already
//     has; it is the only plugin this node's writer knows how to enable, and
//     another name is refused by name rather than appended by a second code
//     path.
//   - stream_reasoning_deltas may only be declared `true`. The writer only
//     ever sets it true; putting it back is `apn hermes-live disable`'s job,
//     which needs the recorded ConfigChange only that verb's state file has.
func delegatePlugins(state *hermesDelegationState, doc []byte, d DeclaredSetting, keyPath string) delegatedEdit {
	wantsEnable := false
	switch d.SettingID {
	case "hermes.plugins.enabled":
		items, ok := toStringList(d.Value)
		if !ok {
			return refused("SHAPE_UNEXPECTED", "%s: declared value is not a list of strings", keyPath)
		}
		current, _, err := configedit.Read(doc, pluginsEnabledKey)
		if err != nil {
			return refused("UNREADABLE", "%s could not be read: %v", pluginsEnabledKey, err)
		}
		already := map[string]bool{}
		if list, ok := current.([]any); ok {
			for _, v := range list {
				if s, ok := v.(string); ok {
					already[s] = true
				}
			}
		}
		for _, item := range items {
			if item == hermeslive.Name || already[item] {
				continue
			}
			return refused("SHAPE_UNEXPECTED",
				"%s: %s is the only plugin this node can enable, and %q was declared — another plugin is enabled through Hermes' own configuration, not from here",
				keyPath, hermeslive.Name, item)
		}
		for _, item := range items {
			if item == hermeslive.Name {
				wantsEnable = true
			}
		}
	case "hermes.plugins.stream_reasoning_deltas":
		on, ok := d.Value.(bool)
		if !ok {
			return refused("SHAPE_UNEXPECTED",
				"%s: this setting holds a boolean and %#v was declared — the value must be the boolean true, not a string spelling of it",
				keyPath, d.Value)
		}
		if !on {
			return refused("SHAPE_UNEXPECTED",
				"%s: the writer this setting delegates to only ever sets it true; turning it off restores what the profile had before the plugin was enabled, which is `apn hermes-live disable`'s job and needs that command's own record of what enabling changed",
				keyPath)
		}
		wantsEnable = true
	}

	if wantsEnable && !state.pluginsRan {
		edited, change, err := hermeslive.PlanEnableConfig(doc)
		if err != nil {
			if errors.Is(err, hermeslive.ErrDisabledByOperator) {
				return refused("OPTED_OUT",
					"%s: Hermes' own plugins.disabled names %s, so an operator turned it off through the harness itself; agentpod never writes that list and will not override it",
					keyPath, hermeslive.Name)
			}
			return refused("SHAPE_UNEXPECTED", "%s: %v", keyPath, err)
		}
		state.pluginsRan = true
		state.pluginsChange = change
		doc = edited
	}

	out := delegatedEdit{
		doc:      doc,
		keyPaths: []string{pluginsEnabledKey, streamDeltasKey},
		additive: map[string][]string{pluginsEnabledKey: {}},
	}
	// The addition is claimed once per derivation, by whichever declared
	// setting ran the writer. Claiming it twice would over-claim an entry as
	// ours, which containment is built to catch.
	if state.pluginsChange.EnabledAdded && !state.pluginsAddition {
		state.pluginsAddition = true
		out.additive[pluginsEnabledKey] = []string{hermeslive.Name}
	}

	switch d.SettingID {
	case "hermes.plugins.enabled":
		out.action = "noop"
		if state.pluginsChange.EnabledAdded {
			out.action = "append"
		}
		merged, _, err := configedit.Read(out.doc, pluginsEnabledKey)
		if err != nil {
			return refused("UNREADABLE", "%s could not be read back after the edit: %v", pluginsEnabledKey, err)
		}
		out.intended = merged
	case "hermes.plugins.stream_reasoning_deltas":
		switch state.pluginsChange.StreamPrevious {
		case "false":
			out.action = "modify"
		case "absent":
			out.action = "create"
		default:
			// "true" — already what was declared — or "" when the writer did
			// not run at all.
			out.action = "noop"
		}
		out.intended = true
	}
	return out
}
