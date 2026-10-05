# Declared Harness Configuration 3c — the console panel

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An operator can see, on a station's page, every registered harness setting with its declared value, this station's observed value and its state — and apply a reviewed plan without leaving the page or touching a shell.

**Architecture:** Everything this panel needs already exists and is live: the registry, the observation states, and the plan → inspect → apply trio behind a digest. The panel is a **reader and a reviewer**; it invents no new apply path and talks to the same routes `fleet config` does. It mirrors `PluginManagementPanel.svelte`, which already solves this exact shape for plugins.

**Tech Stack:** SvelteKit with `adapter-static`, Svelte 5 runes, bits-ui, Tailwind; vitest.

**Spec:** `docs/superpowers/specs/2026-10-05-declared-harness-config-phase-3-design.md` (**D13**), and its parent `2026-10-04-declared-harness-config-design.md` (§8).

**Shipped before this:** #663, #666, #667, #668, #669. `v0.1.88` runs on the fleet; `config.manage` resolves on the workspace node's 31 Hermes profiles; all three settings appear in the live registry.

---

## Global Constraints

- **D13 — the panel reviews; it never invents a second apply path.** Apply goes through the same `plan` → digest → `apply` the CLI uses, against the same routes. **The panel must never offer an apply that did not come from a plan it displayed**, because the digest is the record that a human saw the edit.
- **D4 — nothing restarts a harness.** A setting that needs a restart shows `awaiting-restart` and says agentpod will not restart it. The station page already has its own restart control; the panel may point at it, never do it.
- **The raw config editor stays, unchanged.** `ConfigEditor.svelte` keeps handling everything unregistered. This panel sits beside it and does not absorb it.
- **`set` declares; `apply` writes.** If the panel offers declaring at all, it must not imply declaring changed a station.
- **An exemption is visible, not editable here** unless Task 4 says otherwise: `opted-out` must be shown with its source distinguished — an agentpod exemption reads differently from the harness's own.
- **It is SvelteKit** — `pnpm check` runs `svelte-kit sync`. Console production builds need `PUBLIC_HUB_URL` baked in; you are not deploying, so this matters only if you touch build config, which you should not.
- **Global teardown in `apps/console/src/vitest-setup.ts` flushes bits-ui's scroll-lock timer.** Do not remove it and do not add per-file workarounds — that is a documented gotcha.
- **No workspace-local host names or agent names** in code, tests or copy. The product word is *workspace*.
- **Every predicate test is revert-proofed.** Nine tests across this feature turned out unable to fail, two of them because a correct assertion was satisfied by an entirely different code path. For each test guarding a decision here: break the thing it guards, watch it fail, restore it, record what you saw.

### The precedent to follow closely

`apps/console/src/lib/components/stations/PluginManagementPanel.svelte` (190 lines) already does plan → review → apply-by-digest for plugins, is tested at `PluginManagementPanel.svelte.test.ts`, and is mounted conditionally at `apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte:678` behind `hasPluginManagement`. **Read it and its test before writing anything.** Reuse its `perform` wrapper, its state labels, and crucially its digest discipline: at line 77 it captures `plan.planDigest` from the plan it is *displaying*, which is D13 already expressed in code.

### Running the suites

```bash
cd apps/console && pnpm check && pnpm test
cd apps/console && pnpm build       # adapter-static; catches route/import errors a unit test cannot
```

Console tests are vitest, not bun. The hub and node suites are unaffected by this plan; run them once at the end to prove that.

---

## File Structure

- Create: `apps/console/src/lib/components/stations/HarnessConfigPanel.svelte`
- Create: `apps/console/src/lib/components/stations/HarnessConfigPanel.svelte.test.ts`
- Modify: `apps/console/src/lib/api/` — the client calls (find the existing module the plugin panel uses; follow it)
- Modify: `apps/console/src/routes/nodes/[id]/stations/[stationId]/+page.svelte` — mount behind the `config.manage` capability
- Modify: `docs-site/src/content/docs/use/config.md` — one section saying the console can do this

---

## Task 1: The API client calls

**Files:** `apps/console/src/lib/api/` (the module the plugin panel calls into), plus its test if one exists

**Interfaces produced**, consumed by Tasks 2–4. Shapes come from the contract (`packages/contract/src/harness-config.ts`) — import the types, do not redeclare them:
```ts
listConfigSettings(): Promise<{ settings: ConfigSetting[]; unreachableNodes: string[] }>
getStationConfig(stationId): Promise<{ observations: ConfigObservation[] }>
planStationConfig(stationId, settingIds?): Promise<ConfigPlan>
inspectConfigOperation(stationId, operationId): Promise<ConfigReceipt>
applyStationConfig(stationId, operationId, planDigest): Promise<ConfigReceipt>
listConfigOptOuts(filter?): Promise<ConfigOptOutRow[]>
```

Routes, as they exist today:
- `GET  /api/fleet/config/settings`
- `GET  /api/stations/:stationId/config`
- `POST /api/stations/:stationId/config/plan` — body `{settings:[{settingId, value?}]}`; omit `value` to use the declaration
- `GET  /api/stations/:stationId/config/operations/:operationId`
- `POST /api/stations/:stationId/config/apply` — body `{operationId, planDigest}`
- `GET  /api/fleet/config/opt-out`

**A refused plan is an answer, not an exception.** The plan route returns 400 with `{error, code}` for `UNKNOWN_SETTING`, `OUT_OF_SCOPE`, `CREDENTIAL_PATH`, `NOTHING_DECLARED`, `OPTED_OUT`, and 409 for document/state refusals. The client must surface the **code and message**, not collapse them into "request failed" — the whole point of eight distinct refusals is that an operator can tell them apart.

- [ ] **Step 1: Write the failing tests** — each call hits the right URL and method; a 400 refusal surfaces its `code` and `message`; a 502 surfaces as the station being unreachable rather than as a refusal.
- [ ] **Step 2: Run them and watch them fail.** Report what they said.
- [ ] **Step 3: Implement**, following the existing api module's idiom exactly.
- [ ] **Step 4: `pnpm check && pnpm test`, commit.**

---

## Task 2: The panel reads

**Files:** `HarnessConfigPanel.svelte`, `HarnessConfigPanel.svelte.test.ts`

One row per registered setting for this station's harness, each showing: the setting id, its scope and policy, the declared value and **which level it came from** (station, node or fleet), this station's observed value, and its state.

All seven states must render distinguishably, each with its reason where one exists:

| state | what the row must convey |
|---|---|
| `matches` | declared and observed agree |
| `drifted` | they differ — show both |
| `absent` | declared, and the key is not in the document |
| `unreadable` | the document could not be read — **never** shown as agreement |
| `out-of-scope` | this declaration cannot apply to this station, and why |
| `opted-out` | an operator exempted it — **and whether that was agentpod or the harness itself** |
| `awaiting-restart` | written, not yet in effect, and **agentpod will not restart the harness** |

- [ ] **Step 1: Write the failing tests** — one per state, asserting the state is visible and its reason rendered; a station with nothing declared shows an empty state rather than an error; an unreachable station says so and does not render stale values as current.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement the read-only panel.**
- [ ] **Step 4: Mount it** at `+page.svelte`, conditional on the station advertising `config.manage` — mirroring how `hasPluginManagement` gates the plugin panel at line 678. A station without the capability shows nothing, not an empty panel.
- [ ] **Step 5: Prove the `unreadable` row cannot read as agreement** — make the component treat an unknown state as `matches` and watch that test fail. Restore.
- [ ] **Step 6: `pnpm check && pnpm test && pnpm build`, commit.**

---

## Task 3: Plan, review, apply

**Files:** `HarnessConfigPanel.svelte`, its test

The flow, mirroring the plugin panel's states (`requested` → `planning` → `planned` → `applying` → `applied` / `conflict`):

1. **Plan** — asks for a plan over the settings that need writing. Show each entry: the file, the key path, current → intended, and the action (`create` / `modify` / `append` / `noop`). Show the diff the plan carries, and the digest.
2. **Review** — the operator reads the plan. Nothing has been written.
3. **Apply** — sends `{operationId, planDigest}` taken **from the displayed plan**. Never re-derive, never re-fetch a digest at apply time.

**Four things the panel must get right, each with a test:**

- **A refused plan shows its refusal code and message** and offers no apply button. An `OPTED_OUT` refusal reads differently from `CREDENTIAL_PATH`.
- **A `noOp` plan offers no apply** — nothing to write means nothing to review.
- **A plan whose digest no longer matches is refused by the hub** (`PLAN_STALE` / `PLAN_DIGEST_MISMATCH`) and the panel says the document changed and a fresh plan is needed — it must not silently re-plan and apply.
- **`restartRequired` is surfaced before the apply, and after it the row reads `awaiting-restart`** with the statement that agentpod will not restart the harness.

- [ ] **Step 1: Write the failing tests** for all four, plus the happy path end to end with a mocked client.
- [ ] **Step 2: Run them and watch them fail.**
- [ ] **Step 3: Implement**, reusing the plugin panel's `perform` wrapper and in-flight locking so a double click cannot double-apply.
- [ ] **Step 4: Prove the digest discipline — this is D13 and the most important test here.** Change the component to fetch a fresh plan at apply time instead of using the displayed one; the test asserting the applied digest equals the displayed plan's must FAIL. Restore. Report what you saw.
- [ ] **Step 5: `pnpm check && pnpm test && pnpm build`, commit.**

---

## Task 4: Exemptions, read-only

**Files:** `HarnessConfigPanel.svelte`, its test

The opt-out register has a full API and CLI. This panel **shows** exemptions so a row's `opted-out` state is explicable: which level it came from (station or node), who recorded it, and the reason if one was given.

**Ruling: the panel does not create or clear exemptions in this plan.** Reading is what makes the `opted-out` state legible, which is the gap; writing one is a second mutation surface with its own confirmation design, and `fleet config opt-out` already exists. If you believe adding it is small and clearly right, say so in your report — do not add it silently.

- [ ] **Step 1: Failing tests** — a station-level exemption renders with its level and reason; a node-level one says it came from the node; the harness's own opt-out is distinguished from an agentpod exemption; a row with no exemption shows no exemption chrome.
- [ ] **Step 2: Run and watch them fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: `pnpm check && pnpm test`, commit.**

---

## Task 5: Docs

**Files:** `docs-site/src/content/docs/use/config.md`

The page is live and currently says there is no console control for this — **that claim is false once Task 2 lands.** Find it (`grep -n "console" docs-site/src/content/docs/use/config.md`) and replace it with what the panel actually does.

**Check every claim against the code, not against this plan.** This estate has shipped docs that overstated reality more than once, and this feature alone caught three.

Must be true: where the panel appears and what gates it; that it shows all seven states; that apply goes through the same reviewed plan the CLI uses; that it does not restart anything; that exemptions are visible there but set with `fleet config opt-out`; and that the raw editor is unchanged for anything unregistered.

- [ ] **Step 1: Find and list the false claims.**
- [ ] **Step 2: Rewrite.**
- [ ] **Step 3: Run the docs-claims test** (`cd apps/hub && DATABASE_URL="postgres://agentpod:agentpod-dev-password@localhost:5434/agentpod" bun test tests/unit/docs-claims.test.ts`). It now validates `fleet` subcommands against the CLI's Go source, so any verb you name must exist.
- [ ] **Step 4: Commit.**

---

## Self-review notes

**Spec coverage.** D13 → Tasks 2–4, with Task 3 Step 4 as its proof. §8's "beside the existing raw editor, which stays unchanged" → Task 2 Step 4 and the constraint above. The seven states → Task 2. Exemption visibility → Task 4.

**This plan touches no Go and no hub code.** It runs in its own worktree alongside 3b deliberately: 3b is node and contract, 3c is console. The one file both could want is `docs-site/.../use/config.md` — **3c's Task 5 and 3b's docs task will conflict there.** Whichever lands second rebases and re-checks its claims against the merged page rather than overwriting the other's section.

**The most likely way this goes wrong** is the panel quietly re-deriving a plan at apply time, because that is the convenient thing to write and nothing visible breaks. It defeats the digest's entire purpose — the record that a human saw this exact edit. Task 3 Step 4 exists to catch precisely that, and it must be proved by breaking it.
