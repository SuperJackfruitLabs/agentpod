# Declared harness configuration

**Status:** proposed, 2026-10-04
**Touches:** node-agent (a new optional descriptor interface), hub (declared state,
reconcile, drift), console (a panel), `fleet` (a verb group), contract (six types).

A fleet-declared desired state for a **named, registered set** of harness settings,
reconciled when a station is adopted and reported as drift thereafter. Not a general
config manager — see §2 for why that is a different and worse thing.

## 1. The incident this comes from

Card `card_9d48db2717044b69` on the Agent Onboarding board, 2026-10-04:

| time | event |
|---|---|
| 11:11:36 | a human resolves `gate_0e7405215b404ba0` with `request_changes`, asking for a real clean-room install |
| 11:11:40 | `analyst-echo` (a Hermes station) claims the card |
| 11:12:39 | it needs a shell command and asks. Elicitation opened, five options |
| 11:13:59 | *"the runtime's approval prompt timed out without operator consent"* |
| 11:14:06 | the card parks `blocked`; AC-09 through AC-13 unconfirmed |

The question was alive for **80 seconds**. The hub's elicitation sweep runs every
**five minutes** (`ELICITATION_SWEEP_INTERVAL_MS`), so no sweep could have carried it.
The bridge was willing to wait **thirty** (`DEFAULT_PERMISSION_WAIT_MS`) and never got
the chance: `askTheHuman` is raced against the turn, and the harness ended the turn
first.

Hermes' approval timeout is a config setting — `approvals.timeout`, default 300s — so
this is fixable. The trouble is how it is fixable today:

- by hand, per station, on 36 roster rows, surviving nothing;
- or by an operator tapping **"Allow always"**, which Hermes persists into
  `command_allowlist` in that profile's own `config.yaml` — an invisible divergence of
  one station from the fleet, recorded nowhere agentpod can see.

The second is worse than the first, because it looks like it worked.

## 2. What is declared, and what is not

**In:** a registry of named settings. Each entry names its harness, where it lives in
that harness's document, what scope it belongs to, and what policy governs writing it.
Reachable from the console, the API and `fleet` alike.

**Out: managing all configuration for every harness.** That was asked for directly and
is declined, on three grounds:

**Three formats, six harnesses.** `~/.hermes/config.yaml` (YAML, and a second
`config.yaml` per profile), `~/.openclaw/openclaw.json`, `~/.claude.json`,
`~/.codex/config.toml` (TOML, with `[projects."<path>"]` tables),
`~/.pi/agent/settings.json`, and OpenCode under `~/.local/share/opencode/`. A generic
"set any key on any harness" abstraction is the N-harness maintenance cost
`2026-08-11-kaambaan-bridge-spike-findings.md` §10 warns about, bought for settings
nobody asked to manage.

**A station is not a config scope.** For Hermes a station is a profile and profiles
have their own `config.yaml`, so per-station settings are expressible. For Claude Code,
Codex, OpenCode and Pi a station is a *project path* while the config is **per user** —
so "set this on this station" cannot be honoured without changing its siblings on the
same host. An API that accepted it would be lying. §6 makes the refusal explicit.

**Reach is not the gap.** The `config` capability and panel already read and write each
harness's own file, and `fleet station fs write` does it from a shell. What is missing
is *declared* state, drift detection, and a fleet default — not access.

## 3. Four facts about harness config that shape every decision

**F1 — the harness rewrites its own config.** Hermes' documentation describes
`hermes setup` rewriting `config.yaml`, `hermes migrate` editing it, and automatic
migration on load ("older configs … are automatically migrated … on first load (config
version 17)"). `hermeslive/config.go` already works around this: *"Hermes's own
`plugins entries` and `_config_version` are never touched."*

**F2 — the harness persists operator decisions into it.** "Allow always" writes
`command_allowlist`. That key is a record of human grants, in the file we want to
declare.

**F3 — for two harnesses the config file is the state store.** Detection reads
`~/.claude.json`'s `projects` object and Codex's `[projects."<abs path>"]` tables; the
descriptor calls the latter *"authoritative"*. The harness maintains them. Writing into
a file a harness treats as mutable state is categorically riskier than writing a static
settings file.

**F4 — a write is not the same as being in effect.** Some Hermes keys hot-reload
(`model.context_length`, `compression.*` — *"takes effect on the next message, no
gateway restart"*); others need a restart (API keys, tool and skill config). A config
that says one thing while the running gateway does another is a worse drift than the one
this spec exists to end.

## 4. Decisions

**D1. Named settings only, in a registry.** A setting agentpod can declare is one
somebody wrote an entry for. An unregistered key is refused by name, never written
speculatively. This is the same bound `TOOL_SCOPE` and `PluginManagementHarness` already
draw: the surface is a list, not a pattern.

**D2. Policy per setting, not per system.** One global policy cannot be right for both
`approvals.timeout` and `command_allowlist`. Each entry declares one of:

| policy | means | example |
|---|---|---|
| `reconcilable` | the fleet's value wins; written on adopt, drift reported after | `approvals.timeout` |
| `additive-only` | the fleet guarantees a baseline is **present**; never removes what is there | `command_allowlist`, `skills.external_dirs`, `plugins.enabled` |
| `report-only` | never written by this system; declared so drift is visible | anything whose write is not yet proven |

`additive-only` exists because of F2. Reconciling `command_allowlist` to a declared list
would delete grants an operator made minutes earlier through the harness's own UI —
silently undoing a human decision, which is the worst outcome available here.

**D3. Write on adopt; report drift thereafter.** Adoption already changes a station's
management state, and it is the one moment the operator has customised nothing, so F2's
conflict cannot arise. Continuous reconciliation is rejected: by F1 it would race
`hermes migrate`, and by F2 it would fight the operator. After adopt, a difference is
*reported* and applying it is an explicit reviewed operation.

This is also the estate's existing shape rather than a new position. The node-agent
"updates itself from GitHub releases **when asked to** — there is no timer on the node",
and `CLAUDE.md` names the consequence plainly: "Nodes do not drift forward on their own,
so after a release the fleet stays where it is until someone rolls it." A config
reconciler on a tick would be the first thing in this system that moves a machine
without being asked.

**D4. Never restart, and name the state.** Keeping the invariant every existing verb
states (*"Neither restarts the gateway; that is yours to do"*). By F4 a written setting
may not be live, so the model carries `awaiting-restart` as a distinct state rather than
reporting success.

**D5. Parse to decide, edit as lines to do it.** Exactly as `hermeslive/config.go` and
`hermes-skills register` do, and for the reason they give: *"re-encoding would reflow an
operator's file."* Comments, ordering and formatting are the operator's.

**D6. An explicit operator opt-out wins.** `ErrDisabledByOperator` is already the rule
for `plugins.disabled`: *"That is the operator's explicit choice, and enabling does not
override it."* Declared state does not override it either. Such a station reports
`opted-out`, not `drifted`.

**D7. Scope is declared per setting.** Each entry names `profile`, `project` or `user`.
A station-scoped request for a `user`-scoped setting is refused (§6), because honouring
it would change sibling stations the caller did not name.

**D8. Applying is reviewed, against a plan digest.** The same plan → inspect → apply
shape as skills and plugins: the node plans, the hub records, the apply sends only the
digest that was reviewed. A plan that no longer matches the document is refused rather
than re-derived.

## 5. The model

### Contract (`packages/contract`)

```ts
/** Where a setting lives, and therefore what may be scoped to a station. */
export const ConfigScope = z.enum(["profile", "project", "user"]);

/** What this system may do to a setting's value. See D2. */
export const ConfigPolicy = z.enum(["reconcilable", "additive-only", "report-only"]);

/** One registered setting. The registry is a list of these, in the node-agent. */
export const ConfigSetting = z.object({
  /** Stable id used by the API, the CLI and the declared state. */
  id: z.string(),                       // "hermes.approvals.timeout"
  harness: z.string(),                  // "hermes"
  scope: ConfigScope,
  policy: ConfigPolicy,
  /** Whether a change needs the station restarted to take effect (F4). */
  restartToTakeEffect: z.boolean(),
});

/** What the fleet wants. Stored in the hub, per setting, at one scope. */
export const DeclaredSetting = z.object({
  settingId: z.string(),
  /** null at fleet level; a station id or node id when narrower. */
  stationId: z.string().nullable(),
  nodeId: z.string().nullable(),
  value: z.unknown(),
});

/**
 * What a station actually has. The NODE produces this and knows nothing about
 * what was declared — comparison is the hub's job, because only the hub can
 * resolve station → node → fleet precedence.
 */
export const ConfigValue = z.object({
  settingId: z.string(),
  /** Absent when the key is not in the document. */
  observed: z.unknown().optional(),
  /** False when the document could not be parsed; `observed` is then absent. */
  readable: z.boolean(),
  reason: z.string().optional(),
});

/** What the hub makes of a station's values, once compared against the declaration. */
export const ConfigObservation = z.object({
  settingId: z.string(),
  stationId: z.string(),
  declared: z.unknown().optional(),
  observed: z.unknown().optional(),
  state: z.enum([
    "matches",
    "drifted",
    "absent",            // declared, and the key is not in the document
    "opted-out",         // D6
    "awaiting-restart",  // written, not yet live (F4)
    "unreadable",        // the document could not be parsed — never "matches"
    "out-of-scope",      // declared per-station for a user-scoped setting (D7)
  ]),
  /** Why, whenever the state is not `matches`. Never a bare boolean. */
  reason: z.string().optional(),
});
```

`unreadable` is its own state rather than an error, for the reason the skills inventory
gives about unobserved roots: a document that could not be read must not report as
agreeing.

### Node (`apps/node-agent/internal/descriptor`)

One new optional interface, advertising a `config.manage` capability when implemented —
the same shape as `SkillManagementProvider` and the `plugins.manage` gate:

```go
// ConfigManager is an OPTIONAL interface for descriptors that can read and
// write a registered subset of their harness's own configuration.
//
// `config.manage` is advertised in Detect output ONLY when the descriptor
// implements this, and only for a station whose WorkspacePath is absolute —
// matching how skills.manage is gated.
type ConfigManager interface {
    // ConfigSettings is this harness's registry: every setting it can manage.
    // A key absent here is refused, never written (D1).
    ConfigSettings() []ConfigSetting

    // ObserveConfig reads the current values for `settings` on this station.
    // It never writes, never restarts, and reports an unparseable document as
    // `readable: false` rather than as an absent key.
    //
    // It returns ConfigValue, not ConfigObservation: the node is not told what
    // was declared, so it cannot and must not decide whether a value is drift.
    ObserveConfig(ctx context.Context, key string, settings []string) ([]ConfigValue, error)

    // PlanConfig returns the exact edit it would make, and its digest. It
    // writes nothing.
    PlanConfig(ctx context.Context, key string, want []DeclaredSetting) (ConfigPlan, error)

    // ApplyConfig performs the plan named by planDigest, or refuses if the
    // document no longer matches it (D8). It edits lines, never re-encodes
    // (D5), and touches no key outside the plan.
    ApplyConfig(ctx context.Context, key, operationID, planDigest string) (ConfigReceipt, error)
}
```

`ObserveConfig` is separate from `PlanConfig` on purpose: reading is cheap and safe and
is what drift reporting needs on every sweep; planning is neither.

`ConfigPlan` and `ConfigReceipt` mirror `SkillInstallPlan` and `SkillInstallReceipt`
rather than inventing a second shape: a plan carries an `operationId`, a `planDigest`,
and one entry per setting naming the file, the key, the current value and the intended
value; a receipt carries the same entries with what was actually written. The receipt's
per-setting record takes the shape `hermeslive.ConfigChange` already uses — which keys
were created versus modified — so an undo can reverse exactly that and no more.

### Hub

- **Declared state** in Postgres: one row per `(settingId, scope target)`, with the
  fleet level as `stationId = null, nodeId = null`. Resolution is most-specific-first:
  station, then node, then fleet.
- **On adopt**, after the station is registered: observe, then apply the
  `reconcilable` and `additive-only` settings whose declared value differs. Failures are
  recorded against the station and do not fail the adoption — a station that is adopted
  with one setting unwritten is better than one not adopted.
- **On detect**, observe only. Drift is surfaced, never corrected.
- **Never on a tick.** By F1 and F2 there is no safe moment to write unasked.

## 6. Granularity, concretely

| harness | document | scope of a setting | station-scoped settings |
|---|---|---|---|
| Hermes | `~/.hermes/config.yaml`, and each profile's own | `profile` | **yes, for a leaf** — see below |
| OpenClaw | `~/.openclaw/openclaw.json` | `user` | no |
| Claude Code | `~/.claude.json` | `user` (`projects` keyed by path) | no |
| Codex | `~/.codex/config.toml` | `user` (`[projects."<path>"]`) | no |
| Pi | `~/.pi/agent/settings.json` | `user` | no |
| OpenCode | `~/.local/share/opencode/` | `user` | no |

Hermes needs one more distinction: its root station is **composite** and its children are
the profiles. A `profile`-scoped setting declared against the composite station is refused
with `out-of-scope` exactly as a `user`-scoped one is — the root has no profile of its own
to write, and silently fanning the value out to every child would be a different and much
larger act than the caller asked for. Declaring it per child, or at node or fleet level,
is the supported way to reach them all.

A declaration scoped to a station for a `user`-scoped setting is **refused** with
`out-of-scope`, naming the sibling stations it would have affected. Declaring the same
setting at node or fleet level is the supported way to say it.

Hermes is the only harness where a per-station setting is honest today. That is also the
harness this spec exists for, so the first increment is not blocked by the limitation.

## 7. The first settings

New, and the reason this spec exists:

| id | scope | policy | restart |
|---|---|---|---|
| `hermes.approvals.timeout` | profile | `reconcilable` | assume **yes**, unverified |
| `hermes.approvals.mode` | profile | `reconcilable` | assume **yes**, unverified |
| `hermes.approvals.command_allowlist` | profile | **`additive-only`** | assume **yes**, unverified |

**The restart column for `approvals.*` is not yet known.** Hermes documents hot-reload
for `model.context_length` and `compression.*` and a restart for "API keys and tool/skill
config"; `approvals.*` is named in neither list. The first task of the implementation is
to determine it against a live profile.

Until then each entry declares `restartToTakeEffect: true`, because the two errors are
not symmetric: claiming a restart is needed when it is not costs an unnecessary restart,
while claiming one is not needed when it is produces exactly the F4 state this spec calls
a worse drift — a file that says 900 and a gateway still enforcing 300.

Folded in, so they stop being bespoke — each already has a working, reviewed writer whose
behaviour this registry must preserve exactly:

| id | scope | policy | today |
|---|---|---|---|
| `hermes.plugins.enabled` | profile | `additive-only` | `apn hermes-live` |
| `hermes.plugins.stream_reasoning_deltas` | profile | `reconcilable` | `apn hermes-live` |
| `hermes.skills.external_dirs` | profile | `additive-only` | `apn hermes-skills` |
| `openclaw.hooks.allowConversationAccess` | user | `reconcilable` | `apn openclaw-errors` |

Folding in is **behaviour-preserving or it does not happen.** Each existing verb keeps
working; the registry entry delegates to the same code. `ErrDisabledByOperator` and
`ErrConflict` keep their meanings, surfacing as `opted-out` and a refused plan.

`pi-errors` is deliberately absent: it installs a *file*
(`~/.pi/agent/extensions/agentpod-errors.ts`), not a config key, and does not belong in
a settings registry.

## 8. Surfaces

**CLI** — a verb group in the shape `fleet skills` and `fleet plugins` already use:

```
fleet config settings                                  # the registry: every manageable setting
fleet config show    [--station ID | --node ID]        # declared vs observed, with state
fleet config set     <settingId> --value V [--station ID | --node ID]
fleet config unset   <settingId> [--station ID | --node ID]
fleet config drift                                     # every station whose observed ≠ declared
fleet config plan    --station ID
fleet config inspect --station ID --operation ID
fleet config apply   --station ID --operation ID --plan-digest SHA256
```

`set` records a declaration; it does not write to a station. Writing is `apply`, and the
help says so — the gap between declaring and applying is the design, not an omission.

**API** — `/api/fleet/config/settings`, `/api/fleet/config/declared` (GET, PUT, DELETE),
`/api/stations/:stationId/config` (GET observations), and the plan/inspect/apply trio
under the station, authorised exactly as the skills and plugins routes are.

**Console** — a Config panel section beside the existing raw editor: each registered
setting, its declared value, this station's observed value, and its state. `apply` from
here goes through the same review as a skill install. The raw editor stays for everything
unregistered, unchanged.

## 9. Refusals, each named

A refusal that cannot be told from a pass is the failure this whole area keeps hitting,
so every one of these is distinct and carries a sentence:

| refusal | when |
|---|---|
| `UNKNOWN_SETTING` | an id not in the registry (D1) |
| `OUT_OF_SCOPE` | station-scoped declaration for a `user`-scoped setting (D7) |
| `SHAPE_UNEXPECTED` | the document is not the shape the writer knows — `ErrConflict`'s meaning |
| `PLAN_STALE` | the document changed since the plan was reviewed (D8) |
| `OPTED_OUT` | an explicit operator opt-out (D6) |
| `UNREADABLE` | the document could not be parsed; nothing is inferred |
| `CREDENTIAL_PATH` | the target resolves to a credential file (`auth.json`, `.env`) |

`CREDENTIAL_PATH` is a hard refusal, not a warning. Credentials share these directories
and this system has no business in them; issue #237 already asks the raw config editor to
refuse them.

## 10. Testing

Unit, on the node, against fixture profiles — no live harness:

1. A `reconcilable` setting is written, and **no other key in the document changes** —
   the `sameOutsideOurKeys` guarantee, asserted per setting rather than assumed.
2. An `additive-only` setting with an operator entry already present **keeps that entry**
   and adds the declared one. This is F2's test and the most important in the file.
3. Comments, key order and indentation survive a write (D5).
4. A document carrying an explicit opt-out reports `opted-out` and is not written (D6).
5. An unparseable document reports `unreadable`, never `matches` or `absent`.
6. A station-scoped declaration for a `user`-scoped setting is refused, and the message
   names the sibling stations.
7. A plan applied against a changed document is refused with `PLAN_STALE`.
8. A `restartToTakeEffect` setting reports `awaiting-restart` after a write, and nothing
   is restarted (D4).
9. Each folded-in setting produces **byte-identical** output to the verb it replaces,
   on the same fixture. Behaviour-preserving is a test, not an intention.

Every test must fail before its implementation exists, and a widened predicate must be
mutation-tested — a check that accepts more is exactly the change that can quietly stop
checking.

## 11. What this does not do

- **Not a general config editor.** The raw panel and `fleet station fs` keep that job.
- **No restarts**, ever (D4).
- **No credential writing** (§9).
- **No continuous reconciliation** (D3). A station that drifts after adoption stays
  drifted until somebody applies, and the drift report is how they learn.
- **Does not fix elicitation delivery.** The incident in §1 had two causes, and this
  addresses one. The other is that `elicitation.pending` is in no board's push config, so
  the only route is a five-minute sweep; registering push is separate, smaller, and
  should land first.
- **Does not make per-station settings possible on five of six harnesses** (§6). That is
  a property of those harnesses.
- **Does not raise the pinned ACP adapter versions**, which the guard added today reports
  separately.
