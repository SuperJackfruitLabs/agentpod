package descriptor

import (
	"bytes"
	"context"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/rakeshgangwar/agentpod/node-agent/internal/descriptor/configedit"
	"github.com/rakeshgangwar/agentpod/node-agent/internal/hermeslive"
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

	// optedOutByHarness is a DOCUMENT-level fact — the operator disabled the
	// agentpod-live plugin itself, through Hermes' own plugins.disabled list
	// (D11) — computed once per read, not re-derived per setting id. Every
	// setting this registry manages today lives in the same profile document
	// the plugin's own enablement lives in, so one check serves all of them.
	// Distinct from the hub's own opt-out register: this is the harness's own
	// record, and agentpod never writes it.
	var optedOutByHarness bool
	if readErr == nil {
		optedOutByHarness = hermesPluginDisabled(data, hermeslive.Name)
	}

	out := make([]ConfigValue, 0, len(settings))
	for _, id := range settings {
		if readErr != nil {
			// Unreadable, which is NOT the same as a key that is absent.
			out = append(out, ConfigValue{SettingID: id, Readable: false, Reason: readErr.Error()})
			continue
		}
		where := hermesConfigPath[id]
		v, state := yamlValue(data, where[0], where[1])
		cv := ConfigValue{SettingID: id, Readable: true, OptedOutByHarness: optedOutByHarness}
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
// is a list: ([]any, nil) for a present sequence AND for a key present
// holding nothing (an empty block list, which is the same fact written
// differently), (nil, nil) for anything else present (a nested map — callers
// only reach this from a yamlNotScalar result, so it is always present), or
// (nil, err) if the document could not be re-parsed. It never returns a
// scalar: ObserveConfig's own yamlValue path already owns scalars, and this
// is only consulted when that path found something non-scalar.
func observedList(data []byte, keyPath string) ([]any, error) {
	v, present, err := configedit.Read(data, keyPath)
	if err != nil {
		return nil, err
	}
	if !present {
		return nil, nil
	}
	if v == nil {
		// Present, holding nothing: `command_allowlist:` with no items under
		// it. That is an EMPTY LIST in every sense that matters here — it is
		// the shape AppendToList has a dedicated branch for extending, and it
		// is what an operator's document looks like after the last entry is
		// deleted. Reporting it as a nested map (the arm below) was a false
		// sentence about a document that holds nothing, and it made
		// `compare()` call the setting `unreadable`, which at adopt time
		// records a failure and never plans the write at all.
		return []any{}, nil
	}
	list, ok := v.([]any)
	if !ok {
		return nil, nil
	}
	return list, nil
}

// hermesPluginDisabled reports whether name appears in this document's
// `plugins.disabled` list — Hermes' own mechanism for an operator to turn a
// plugin off through the harness's own UI, which ObserveConfig surfaces as
// `optedOutByHarness` (D11). Reuses observedList (configedit-backed, so a
// block list, an inline list, or a present-but-empty list are all read
// structurally) rather than scanning the YAML as text a second way. Both an
// absent `plugins` section and an absent `disabled` key report `false`, with
// no error: plugins.disabled naming nothing is the ordinary case, not a
// shape this reader cannot speak for.
func hermesPluginDisabled(data []byte, name string) bool {
	list, err := observedList(data, "plugins.disabled")
	if err != nil {
		return false
	}
	for _, v := range list {
		if s, ok := v.(string); ok && s == name {
			return true
		}
	}
	return false
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

// configPlanDerivation is everything deriving a plan computes in memory: the
// reviewable ConfigPlan itself, plus the raw bytes and bookkeeping ApplyConfig
// needs to actually perform — and afterwards re-verify — that same edit,
// without ever being handed `want` again. Entries[].Intended already carries
// enough to reconstruct `want` (see ApplyConfig), so nothing here is specific
// to the first derivation; calling derivePlanConfig twice with the same
// reconstructed `want` is "the same code path" both PlanConfig and ApplyConfig
// run.
type configPlanDerivation struct {
	plan       ConfigPlan
	profileDir string
	path       string
	before     []byte
	after      []byte
	keyPaths   []string
	additive   map[string][]string
}

// derivePlanConfig derives, in memory only, the edit that would satisfy
// `want` on the profile named by key, right now. Neither this nor PlanConfig,
// which is a thin wrapper around it, writes to the document; see
// config_plan.go for the shapes and configedit for the read/edit primitives
// this composes.
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
func (h *hermesDescriptor) derivePlanConfig(ctx context.Context, key, operationID string, want []DeclaredSetting) (configPlanDerivation, error) {
	if err := ctx.Err(); err != nil {
		return configPlanDerivation{}, err
	}

	plan := ConfigPlan{
		SchemaVersion: 1,
		OperationID:   operationID,
		StationKey:    key,
		Entries:       []ConfigPlanEntry{},
		CreatedAt:     time.Now().UTC().Format(time.RFC3339),
	}

	// 1. Resolve the document this key's settings live in, and refuse a
	// credential path before reading anything. Every Hermes setting
	// registered today resolves to config.yaml, so this cannot fire through
	// production data — see isCredentialPath's comment — but the check still
	// runs first, ahead of every other check, so a future setting that DOES
	// resolve elsewhere is never opened even once.
	dir, err := h.workspaceFor(key)
	if err != nil {
		return configPlanDerivation{}, err
	}
	path := filepath.Join(dir, "config.yaml")
	refuse := func(code, message string) (configPlanDerivation, error) {
		plan.Refusal = &ConfigRefusal{Code: code, Message: message}
		plan.PlanDigest = configDigestOf(plan)
		return configPlanDerivation{plan: plan, profileDir: dir, path: path}, nil
	}
	if isCredentialPath(path) {
		return refuse("CREDENTIAL_PATH", fmt.Sprintf("%s names a credential file and will not be read or edited", path))
	}

	// 2. The composite root has no profile-scoped document of its own
	// (spec §6) — reuse isCompositeRoot rather than re-deriving the rule.
	root, err := h.isCompositeRootKey(key)
	if err != nil {
		return configPlanDerivation{}, err
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
			// A `reconcilable` setting holds ONE scalar, and nothing between
			// the command line and here has said so until now: the contract
			// lets a declared value be any JSON type, the hub stores it
			// verbatim as jsonb, and `--json` can type a map, a list or a
			// null. Refused by the setting's own name, the way
			// `additive-only` has always refused a value that is not a list
			// of strings — the writer refuses these too (configedit), but a
			// refusal that names the registry's expectation is the one an
			// operator can act on.
			if !configedit.IsWritableScalar(d.Value) {
				shape := fmt.Sprintf("a %T", d.Value)
				if d.Value == nil {
					shape = "a null"
				}
				return refuse("SHAPE_UNEXPECTED", fmt.Sprintf(
					"%s: %s holds a single scalar value — a string, a number or a boolean — and %s was declared",
					keyPath, d.SettingID, shape))
			}
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
			// Registered even when nothing was added, and deliberately: an
			// entry present with no items makes SameOutsideKeys compare this
			// list strictly on both sides, where deleting the key from both
			// (the non-additive branch) would let an edit that removed every
			// operator entry and added nothing pass containment.
			additive[keyPath] = append(additive[keyPath], added...)
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
			return configPlanDerivation{}, fmt.Errorf("config: %s has an unrecognized policy %q", d.SettingID, setting.Policy)
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
	return configPlanDerivation{
		plan: plan, profileDir: dir, path: path,
		before: before, after: after, keyPaths: keyPaths, additive: additive,
	}, nil
}

// PlanConfig derives, in memory only, the edit that would satisfy `want` on
// the profile named by key, naming operationID so this station's own journal
// can key a receipt by it. It writes nothing to the document: the returned
// ConfigPlan carries the edited document only in its diff, never to disk.
//
// A plan with no refusal IS recorded — phase "planned" — in the station's own
// journal (config_journal.go), because ApplyConfig is handed only an
// operationID and the plan's own digest, never `want` again; without this
// record it would have no way to recover what review actually saw in order
// to re-derive and compare. A refused plan has nothing to apply and is never
// journaled.
func (h *hermesDescriptor) PlanConfig(ctx context.Context, key, operationID string, want []DeclaredSetting) (ConfigPlan, error) {
	d, err := h.derivePlanConfig(ctx, key, operationID, want)
	if err != nil {
		return ConfigPlan{}, err
	}
	if d.plan.Refusal == nil {
		journal := openConfigJournal(d.profileDir)
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

// conflictReceipt is an UNRECORDED answer: it reports why an apply will not
// proceed without touching the journal, so the reviewed plan already on
// record (whatever it was) survives for a legitimate retry.
func conflictReceipt(plan ConfigPlan, code, message string) ConfigReceipt {
	plan.Refusal = &ConfigRefusal{Code: code, Message: message}
	return ConfigReceipt{
		Plan:      plan,
		Phase:     "conflict",
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	}
}

// ApplyConfig applies the plan reviewed as planDigest for operationID,
// writing the document exactly once and never restarting the harness (D4;
// the receipt has no `restarted` field). The order is the whole point:
//
//  1. Load the journal entry for operationID — absent is an error (never a
//     silent plan).
//  2. The supplied planDigest must equal the journal entry's own plan digest.
//     This is checked before the idempotent return, so proof of review is
//     required even for an operation already applied; only then is an
//     already-"applied" entry returned unchanged (idempotent).
//  3. The plan is RE-DERIVED from the document as it is right now, via
//     derivePlanConfig — the same code path PlanConfig uses — reconstructing
//     `want` from the journaled plan's own Entries[].Intended.
//  4. A re-derived digest that disagrees with the journaled one means the
//     document changed after review: phase "conflict", refusal PLAN_STALE,
//     and nothing is written.
//  5. Only now is the edit written, atomically. The bytes actually on disk
//     afterward are re-checked with configedit.SameOutsideKeys; a violation
//     here — after step 3 already proved containment — means the document
//     changed under us in the gap between the write and the read-back that
//     verifies it (D10). That is a lost race, not a corruption: the document
//     is left exactly as this step found it — reverting to what step 3 read
//     would discard whatever just landed there, possibly an operator's own
//     "Allow always" from seconds earlier, which is exactly the loss F2
//     exists to prevent — and this station's own intended edit is saved
//     beside it as a sidecar file instead of being thrown away. See
//     writeAndReadBack and writeRejectedSidecar.
//  6. The receipt — phase "applied", Written, AfterSHA256 — is recorded.
func (h *hermesDescriptor) ApplyConfig(ctx context.Context, key, operationID, planDigest string) (ConfigReceipt, error) {
	if err := ctx.Err(); err != nil {
		return ConfigReceipt{}, err
	}
	dir, err := h.workspaceFor(key)
	if err != nil {
		return ConfigReceipt{}, err
	}

	journal := openConfigJournal(dir)
	unlock := journal.lock()
	defer unlock()

	existing, err := journal.read(operationID)
	if err != nil {
		return ConfigReceipt{}, err
	}
	// 2. The caller's proof of review must match what this station actually
	// has on record for operationID — checked BEFORE the idempotent return
	// below, or that return would hand the applied receipt back for any
	// digest at all (an empty one, a fabricated one), making the proof-of-
	// review check unreachable on the one path a retry actually takes.
	if planDigest != existing.Plan.PlanDigest {
		return conflictReceipt(existing.Plan, "PLAN_DIGEST_MISMATCH",
			fmt.Sprintf("the supplied plan digest does not match the plan reviewed for %s", operationID)), nil
	}
	if existing.Phase == "applied" {
		return existing, nil
	}

	// 3. Re-derive, reconstructing `want` from exactly what review saw:
	// Entries[].Intended is the declared value for a reconcilable setting,
	// and the full (already-merged) list for an additive-only one — which
	// re-declaring is safe, since AppendToList only ever adds what is not
	// already present.
	want := make([]DeclaredSetting, len(existing.Plan.Entries))
	for i, e := range existing.Plan.Entries {
		want[i] = DeclaredSetting{SettingID: e.SettingID, Value: e.Intended}
	}
	redo, err := h.derivePlanConfig(ctx, key, operationID, want)
	if err != nil {
		return ConfigReceipt{}, err
	}

	// 4. A document that no longer matches what was reviewed re-derives to a
	// different digest — most directly because BeforeSHA256 and Diff are
	// both part of what configDigestOf hashes, and both depend on the
	// document's actual bytes, not just the value at the keys this plan
	// touches.
	if redo.plan.PlanDigest != existing.Plan.PlanDigest {
		return conflictReceipt(existing.Plan, "PLAN_STALE",
			fmt.Sprintf("%s changed after this plan was reviewed; re-plan and re-review before applying", redo.path)), nil
	}

	// 5. Write, then verify on the bytes actually on disk — not the `after`
	// this process computed in memory — so a filesystem change concurrent
	// with the write is caught rather than assumed away.
	mode := os.FileMode(0o600)
	if info, statErr := os.Stat(redo.path); statErr == nil {
		mode = info.Mode().Perm()
	}
	actual, err := h.writeAndReadBack(redo.path, redo.before, redo.after, mode)
	if err != nil {
		return ConfigReceipt{}, err
	}

	if err := configedit.SameOutsideKeys(redo.before, actual, redo.keyPaths, redo.additive); err != nil {
		// D10: `actual` is the document exactly as this race left it on
		// disk. It is not reverted to redo.before (that would discard
		// whatever concurrent edit just landed — see the comment on
		// ApplyConfig above) and it is not forced to redo.after either (that
		// would discard the concurrent edit in the other direction). It is
		// left untouched, and this station's own intended edit is saved
		// beside it instead, so a human can reconcile the two without
		// either ever having been thrown away.
		sidecarPath, sidecarErr := writeRejectedSidecar(redo.path, redo.after, mode)
		msg := fmt.Sprintf(
			"the write touched more than its plan: %v; %s was left untouched and the intended edit was saved instead to %s — neither edit has been lost, but they must be reconciled by hand",
			err, redo.path, sidecarPath)
		if sidecarErr != nil {
			msg = fmt.Sprintf("%s (and saving the intended edit to %s also failed: %v)", msg, sidecarPath, sidecarErr)
		}
		receipt := ConfigReceipt{
			Plan:      existing.Plan,
			Phase:     "conflict",
			UpdatedAt: time.Now().UTC().Format(time.RFC3339),
			Error:     msg,
		}
		// A real write already happened; record it rather than let a second
		// apply attempt believe nothing was ever tried.
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

// writeAndReadBack is ApplyConfig's step 5: write `after` over `path`, atomically,
// when it differs from `before`, then read back whatever is actually on disk
// afterward — not the `after` just written, because that is precisely the
// assumption D10 exists to not make.
//
// It is pulled out of ApplyConfig, rather than left inline, because this is
// the one gap this algorithm actually has: between the write landing and the
// read-back that verifies it, nothing holds the document still. A real test
// of that race should land something in exactly that gap, not fake the
// timing with a sleep — so h.afterApplyWriteForTest, when set, is called
// right there. It is nil in production and this function then does exactly
// what it reads: write, then read back.
func (h *hermesDescriptor) writeAndReadBack(path string, before, after []byte, mode os.FileMode) ([]byte, error) {
	if bytes.Equal(before, after) {
		return before, nil
	}
	if err := atomicWriteFile(path, after, mode); err != nil {
		return nil, fmt.Errorf("config: writing %s: %w", path, err)
	}
	if h.afterApplyWriteForTest != nil {
		h.afterApplyWriteForTest(path)
	}
	written, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("config: reading back %s: %w", path, err)
	}
	return written, nil
}

// rejectedSidecarPath returns where a lost race's intended edit is saved:
// configPath with ".agentpod-rejected" appended to its full name, so
// "config.yaml" becomes "config.yaml.agentpod-rejected" sitting right next
// to it.
func rejectedSidecarPath(configPath string) string {
	return configPath + ".agentpod-rejected"
}

// writeRejectedSidecar saves intended beside configPath, atomically, using
// the same temp-file-plus-rename writer every other write in this package
// uses — this is not a second way to write a file, just a second path to
// write it to.
//
// This is the ONE place in the whole declared-configuration design that
// writes a file the harness itself does not own or ever read: every other
// write here lands inside a document the harness will itself parse at its
// next read, but a harness has no notion of ".agentpod-rejected" and never
// will. It exists purely as bookkeeping for a human to reconcile by hand —
// nothing in this system reads it back, so it is safe (and correct) for a
// later rejection of the same document to silently overwrite whatever an
// earlier one left here; there is no history to preserve, only a latest
// answer to the question "what did we intend to write."
func writeRejectedSidecar(configPath string, intended []byte, mode os.FileMode) (string, error) {
	path := rejectedSidecarPath(configPath)
	if err := atomicWriteFile(path, intended, mode); err != nil {
		return path, err
	}
	return path, nil
}

// InspectConfig returns the receipt this station's journal has recorded for
// operationID, exactly as recorded — it never re-derives or re-plans, so a
// document edited after an apply still shows what review actually saw and
// what was actually written, not a readout of the document as it is now.
func (h *hermesDescriptor) InspectConfig(ctx context.Context, key, operationID string) (ConfigReceipt, error) {
	if err := ctx.Err(); err != nil {
		return ConfigReceipt{}, err
	}
	dir, err := h.workspaceFor(key)
	if err != nil {
		return ConfigReceipt{}, err
	}
	return openConfigJournal(dir).read(operationID)
}
