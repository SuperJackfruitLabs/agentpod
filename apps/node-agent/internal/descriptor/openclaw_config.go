package descriptor

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/openclawerrors"
)

// openclawAllowConversationAccessID is the one OpenClaw setting this
// registry folds in (spec F6): `apn openclaw-errors` already enables and
// disables it, and this registry entry delegates to the same writer rather
// than reimplementing it (D12).
const openclawAllowConversationAccessID = "openclaw.hooks.allowConversationAccess"

// openclawConfigRegistry is the whole set of OpenClaw settings this system
// manages — a list, not a pattern (D1), exactly as hermesConfigRegistry is.
//
// Scope is "user": OpenClaw keeps one configuration file per host
// (~/.openclaw/openclaw.json), shared by every subagent station, so a
// station-scoped declaration of this setting is already refused
// `out-of-scope` by the hub's existing, harness-agnostic scope rule
// (apps/hub/src/services/harness-config.ts: `setting.scope !== "profile" &&
// level === "station"`) before it would ever reach this node. No refusal
// needs adding here (spec §6, D7) — see
// TestOpenClawConfigSettingsRegistry (openclaw_config_test.go) and the hub's
// own `harness-config-compare.test.ts`, which already exercises this exact
// setting id generically.
var openclawConfigRegistry = []ConfigSetting{
	{ID: openclawAllowConversationAccessID, Harness: "openclaw", Scope: "user", Policy: "reconcilable", RestartToTakeEffect: true},
}

// ConfigSettings implements ConfigManager.
func (o *openclawDescriptor) ConfigSettings() []ConfigSetting {
	out := make([]ConfigSetting, len(openclawConfigRegistry))
	copy(out, openclawConfigRegistry)
	return out
}

// openclawConfigDocPath is OpenClaw's own configuration — the SAME file
// every station key resolves to, because the one registered setting is
// user-scoped: there is one document per host, not one per station.
func (o *openclawDescriptor) openclawConfigDocPath() string {
	return filepath.Join(o.home, "openclaw.json")
}

// openclawErrorsPluginDir is where `apn openclaw-errors` keeps the plugin's
// files, mirroring openclawerrors.PluginDir(userHome). o.home is the
// ".openclaw" directory itself (NewOpenClawFrom's default is "<user
// home>/.openclaw"), so its parent is the user home PluginDir expects — the
// same relationship `apn openclaw-errors`, which always resolves the real OS
// home directory on its own, holds for every default installation this
// registry entry will ever see.
func (o *openclawDescriptor) openclawErrorsPluginDir() string {
	return openclawerrors.PluginDir(filepath.Dir(o.home))
}

// openclawReadAllowConversationAccess reads
// plugins.entries.agentpod-errors.hooks.allowConversationAccess from an
// OpenClaw configuration already decoded as a generic JSON value. present is
// false when any step of that path is absent; a present value that is not a
// boolean is reported as absent too — not a shape this reader can speak
// for, and both ObserveConfig and PlanConfig treat "absent" as "ask the
// writer", never as a parse failure of the document itself.
func openclawReadAllowConversationAccess(doc map[string]any) (value, present bool) {
	plugins, _ := doc["plugins"].(map[string]any)
	if plugins == nil {
		return false, false
	}
	entries, _ := plugins["entries"].(map[string]any)
	if entries == nil {
		return false, false
	}
	entry, ok := entries[openclawerrors.Name].(map[string]any)
	if !ok {
		return false, false
	}
	hooks, _ := entry["hooks"].(map[string]any)
	if hooks == nil {
		return false, false
	}
	v, ok := hooks["allowConversationAccess"].(bool)
	if !ok {
		return false, false
	}
	return v, true
}

// openclawSemanticEqual reports whether a and b are the same JSON value,
// ignoring formatting — the same comparison openclawerrors' own PlanEnable
// and PlanDisable use (sameJSON, install.go) to decide NoOp, because
// EnableConfig/DisableConfig re-indent the whole "plugins" value on every
// call (openclawerrors.splicePlugins) even when nothing inside it changed.
// Without this, re-declaring an already-satisfied setting against a
// `plugins` subtree whose formatting predates this writer would report a
// change and rewrite it — exactly the wholesale re-encode D5 forbids.
func openclawSemanticEqual(a, b []byte) bool {
	var x, y any
	if json.Unmarshal(a, &x) != nil || json.Unmarshal(b, &y) != nil {
		return false
	}
	ja, _ := json.Marshal(x)
	jb, _ := json.Marshal(y)
	return bytes.Equal(ja, jb)
}

// openclawConfigDerivation is everything deriving a plan computes in
// memory, mirroring hermes_config.go's configPlanDerivation but without its
// YAML-specific keyPaths/additive bookkeeping: OpenClaw's whole edit is
// delegated to one writer that owns the entire "plugins" value by
// construction, so there is no per-key containment to track separately.
type openclawConfigDerivation struct {
	plan   ConfigPlan
	path   string
	before []byte
	after  []byte
}

// derivePlanConfig derives, in memory only, the edit that would satisfy
// `want` on the station named by key, right now. Neither this nor
// PlanConfig, which is a thin wrapper around it, writes to the document.
//
// Checks run in this order, each its own refusal:
//
//  1. CREDENTIAL_PATH — before the document is read at all. Never fires
//     through the real registry (openclaw.json is not a credential
//     basename), kept for the same defense-in-depth reason hermes_config.go
//     keeps it.
//  2. UNKNOWN_SETTING — any requested id this harness does not register.
//  3. UNREADABLE — the document does not parse as JSON.
//  4. SHAPE_UNEXPECTED — the declared value is not a boolean, or the
//     delegated writer (openclawerrors.EnableConfig/DisableConfig) refuses
//     the document's shape (ErrConflict's JSON-side equivalent).
func (o *openclawDescriptor) derivePlanConfig(ctx context.Context, key, operationID string, want []DeclaredSetting) (openclawConfigDerivation, error) {
	if err := ctx.Err(); err != nil {
		return openclawConfigDerivation{}, err
	}

	plan := ConfigPlan{
		SchemaVersion: 1,
		OperationID:   operationID,
		StationKey:    key,
		Entries:       []ConfigPlanEntry{},
		CreatedAt:     time.Now().UTC().Format(time.RFC3339),
	}

	if _, err := o.workspaceFor(key); err != nil {
		return openclawConfigDerivation{}, err
	}
	path := o.openclawConfigDocPath()
	refuse := func(code, message string) (openclawConfigDerivation, error) {
		plan.Refusal = &ConfigRefusal{Code: code, Message: message}
		plan.PlanDigest = configDigestOf(plan)
		return openclawConfigDerivation{plan: plan, path: path}, nil
	}
	if isCredentialPath(path) {
		return refuse("CREDENTIAL_PATH", fmt.Sprintf("%s names a credential file and will not be read or edited", path))
	}

	for _, d := range want {
		if d.SettingID != openclawAllowConversationAccessID {
			return refuse("UNKNOWN_SETTING", fmt.Sprintf("%s is not a setting this harness manages", d.SettingID))
		}
	}

	before, err := os.ReadFile(path)
	if err != nil {
		return refuse("UNREADABLE", fmt.Sprintf("%s could not be read: %v", path, err))
	}
	if !json.Valid(before) {
		return refuse("UNREADABLE", fmt.Sprintf("%s is not valid JSON", path))
	}

	after := before
	entries := make([]ConfigPlanEntry, 0, len(want))
	pluginDir := o.openclawErrorsPluginDir()
	keyPath := fmt.Sprintf("plugins.entries.%s.hooks.allowConversationAccess", openclawerrors.Name)

	for _, d := range want {
		val, ok := d.Value.(bool)
		if !ok {
			shape := fmt.Sprintf("a %T", d.Value)
			if d.Value == nil {
				shape = "a null"
			}
			return refuse("SHAPE_UNEXPECTED", fmt.Sprintf(
				"%s: this setting holds the boolean true or false, and %s was declared",
				keyPath, shape))
		}

		var afterDoc map[string]any
		if err := json.Unmarshal(after, &afterDoc); err != nil {
			return refuse("UNREADABLE", fmt.Sprintf("%s is not valid JSON: %v", path, err))
		}
		current, present := openclawReadAllowConversationAccess(afterDoc)

		entry := ConfigPlanEntry{
			SettingID:           d.SettingID,
			File:                path,
			KeyPath:             keyPath,
			Policy:              "reconcilable",
			Intended:            val,
			RestartToTakeEffect: true,
		}
		if present {
			entry.Current = current
		}

		// D6: an explicit operator opt-out wins over a declared value. The
		// delegated writer (EnableConfig) is indivisible — it ALSO flips
		// plugins.entries.agentpod-errors.enabled to true, which would
		// silently reverse an operator's own choice to turn the plugin off
		// through OpenClaw's own UI. Checked only when actually trying to
		// enable: declaring the hook off while the plugin is already
		// disabled is consistent with the opt-out and needs no refusal.
		if val && openclawerrors.PluginExplicitlyDisabled(after) {
			return refuse("OPTED_OUT", fmt.Sprintf(
				"%s: OpenClaw's own plugins.entries.%s.enabled is false, so an operator turned the plugin off through OpenClaw's own UI; agentpod never writes that key and will not override it by enabling hooks.allowConversationAccess",
				keyPath, openclawerrors.Name))
		}

		var edited []byte
		var writeErr error
		if val {
			edited, writeErr = openclawerrors.EnableConfig(after, pluginDir)
		} else {
			edited, writeErr = openclawerrors.DisableConfig(after, pluginDir)
		}
		if writeErr != nil {
			return refuse("SHAPE_UNEXPECTED", fmt.Sprintf("%s: %v", path, writeErr))
		}

		if openclawSemanticEqual(after, edited) {
			entry.Action = "noop"
		} else {
			if present {
				entry.Action = "modify"
			} else {
				entry.Action = "create"
			}
			after = edited
		}
		entries = append(entries, entry)
	}

	plan.Entries = entries
	plan.BeforeSHA256 = sha256Hex(before)
	plan.Diff, plan.DiffTruncated = buildDiff(before, after)
	plan.NoOp = bytes.Equal(before, after)

	restart := false
	for _, e := range entries {
		if e.Action != "noop" && e.RestartToTakeEffect {
			restart = true
		}
	}
	plan.RestartRequired = restart

	plan.PlanDigest = configDigestOf(plan)
	return openclawConfigDerivation{plan: plan, path: path, before: before, after: after}, nil
}

// PlanConfig implements ConfigManager. See hermes_config.go's PlanConfig for
// the full rationale this mirrors: a plan with no refusal is recorded
// (phase "planned") in this station's own journal, keyed by operationID, so
// ApplyConfig can recover what review saw.
func (o *openclawDescriptor) PlanConfig(ctx context.Context, key, operationID string, want []DeclaredSetting) (ConfigPlan, error) {
	d, err := o.derivePlanConfig(ctx, key, operationID, want)
	if err != nil {
		return ConfigPlan{}, err
	}
	if d.plan.Refusal == nil {
		journal := openConfigJournal(o.home)
		unlock := journal.lock()
		err := journal.write(ConfigReceipt{
			Plan:      d.plan,
			Phase:     "planned",
			UpdatedAt: time.Now().UTC().Format(time.RFC3339),
		})
		unlock()
		if err != nil {
			return ConfigPlan{}, fmt.Errorf("config: recording the plan for %s: %w", operationID, err)
		}
	}
	return d.plan, nil
}

// ApplyConfig implements ConfigManager, mirroring hermes_config.go's
// ApplyConfig step for step — re-deriving the plan from the document as it
// is now, refusing PLAN_STALE rather than writing if that no longer matches
// planDigest, writing atomically, and never restarting the harness (D4).
//
// The journal lives at o.home/.agentpod/config-operations.json, not under
// any one station's workspace: every OpenClaw station key shares the SAME
// document, so they share the same operation history too.
func (o *openclawDescriptor) ApplyConfig(ctx context.Context, key, operationID, planDigest string) (ConfigReceipt, error) {
	if err := ctx.Err(); err != nil {
		return ConfigReceipt{}, err
	}

	journal := openConfigJournal(o.home)
	unlock := journal.lock()
	defer unlock()

	existing, err := journal.read(operationID)
	if err != nil {
		return ConfigReceipt{}, err
	}
	if planDigest != existing.Plan.PlanDigest {
		return conflictReceipt(existing.Plan, "PLAN_DIGEST_MISMATCH",
			fmt.Sprintf("the supplied plan digest does not match the plan reviewed for %s", operationID)), nil
	}
	if existing.Phase == "applied" {
		return existing, nil
	}

	want := make([]DeclaredSetting, len(existing.Plan.Entries))
	for i, e := range existing.Plan.Entries {
		want[i] = DeclaredSetting{SettingID: e.SettingID, Value: e.Intended}
	}
	redo, err := o.derivePlanConfig(ctx, key, operationID, want)
	if err != nil {
		return ConfigReceipt{}, err
	}
	if redo.plan.PlanDigest != existing.Plan.PlanDigest {
		return conflictReceipt(existing.Plan, "PLAN_STALE",
			fmt.Sprintf("%s changed after this plan was reviewed; re-plan and re-review before applying", redo.path)), nil
	}

	mode := os.FileMode(0o600)
	if info, statErr := os.Stat(redo.path); statErr == nil {
		mode = info.Mode().Perm()
	}

	actual := redo.before
	if !bytes.Equal(redo.before, redo.after) {
		if err := atomicWriteFile(redo.path, redo.after, mode); err != nil {
			return ConfigReceipt{}, fmt.Errorf("config: writing %s: %w", redo.path, err)
		}
		readBack, err := os.ReadFile(redo.path)
		if err != nil {
			return ConfigReceipt{}, fmt.Errorf("config: reading back %s: %w", redo.path, err)
		}
		actual = readBack
	}

	// D10: the document actually on disk, read back after the write, must be
	// exactly what this apply intended. A mismatch means the file changed
	// under us in the gap between the write landing and this read-back — a
	// lost race, not a corruption. It is left exactly as found (never
	// reverted to redo.before, which would discard whatever just landed
	// there) and this station's own intended edit is saved beside it
	// instead, so a human can reconcile the two without either ever having
	// been thrown away. See hermes_config.go's ApplyConfig for the richer,
	// per-key version of this same guarantee (configedit.SameOutsideKeys);
	// OpenClaw's whole edit is scoped to one top-level JSON member by
	// construction (openclawerrors.splicePlugins), so a plain bytes-equal
	// check against the read-back is an equally sound race detector here —
	// nothing outside "plugins" could have moved without this check firing
	// too.
	if !bytes.Equal(actual, redo.after) {
		sidecarPath, sidecarErr := writeRejectedSidecar(redo.path, redo.after, mode)
		msg := fmt.Sprintf(
			"the write touched more than its plan: %s was left untouched and the intended edit was saved instead to %s — neither edit has been lost, but they must be reconciled by hand",
			redo.path, sidecarPath)
		if sidecarErr != nil {
			msg = fmt.Sprintf("%s (and saving the intended edit to %s also failed: %v)", msg, sidecarPath, sidecarErr)
		}
		receipt := ConfigReceipt{
			Plan:      existing.Plan,
			Phase:     "conflict",
			UpdatedAt: time.Now().UTC().Format(time.RFC3339),
			Error:     msg,
		}
		_ = journal.write(receipt)
		return receipt, nil
	}

	written := make([]ConfigWritten, len(existing.Plan.Entries))
	for i, e := range existing.Plan.Entries {
		written[i] = ConfigWritten{SettingID: e.SettingID, Action: e.Action, Wrote: e.Intended}
	}
	receipt := ConfigReceipt{
		Plan:        existing.Plan,
		Phase:       "applied",
		UpdatedAt:   time.Now().UTC().Format(time.RFC3339),
		Written:     written,
		AfterSHA256: sha256Hex(actual),
	}
	if err := journal.write(receipt); err != nil {
		return ConfigReceipt{}, fmt.Errorf("config: recording the receipt for %s: %w", operationID, err)
	}
	return receipt, nil
}

// ObserveConfig implements ConfigManager. It never writes and never
// restarts; an unreadable document is reported per settingId as
// `Readable: false`, never silently as an absent key.
func (o *openclawDescriptor) ObserveConfig(ctx context.Context, key string, settings []string) ([]ConfigValue, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	for _, id := range settings {
		if id != openclawAllowConversationAccessID {
			return nil, fmt.Errorf("config: %s is not a setting this harness manages", id)
		}
	}
	if _, err := o.workspaceFor(key); err != nil {
		return nil, err
	}

	path := o.openclawConfigDocPath()
	data, readErr := os.ReadFile(path)

	// optedOutByHarness is a DOCUMENT-level fact — the operator disabled the
	// agentpod-errors plugin itself, through OpenClaw's own
	// plugins.entries.agentpod-errors.enabled (D11, D6) — computed once per
	// read, exactly as hermes_config.go's ObserveConfig computes
	// hermesPluginDisabled once and applies it to every setting in the
	// call. There is only one registered OpenClaw setting today, but the
	// shape is kept the same so a second one costs nothing extra here.
	var optedOutByHarness bool
	if readErr == nil {
		optedOutByHarness = openclawerrors.PluginExplicitlyDisabled(data)
	}

	out := make([]ConfigValue, 0, len(settings))
	for _, id := range settings {
		if readErr != nil {
			out = append(out, ConfigValue{SettingID: id, Readable: false, Reason: readErr.Error()})
			continue
		}
		var doc map[string]any
		if err := json.Unmarshal(data, &doc); err != nil {
			out = append(out, ConfigValue{SettingID: id, Readable: false, Reason: fmt.Sprintf("%s is not valid JSON: %v", path, err)})
			continue
		}
		cv := ConfigValue{SettingID: id, Readable: true, OptedOutByHarness: optedOutByHarness}
		if v, present := openclawReadAllowConversationAccess(doc); present {
			cv.Observed = v
		}
		out = append(out, cv)
	}
	return out, nil
}

// InspectConfig implements ConfigManager: the receipt this station's
// journal has recorded for operationID, exactly as recorded.
func (o *openclawDescriptor) InspectConfig(ctx context.Context, key, operationID string) (ConfigReceipt, error) {
	if err := ctx.Err(); err != nil {
		return ConfigReceipt{}, err
	}
	if _, err := o.workspaceFor(key); err != nil {
		return ConfigReceipt{}, err
	}
	return openConfigJournal(o.home).read(operationID)
}
