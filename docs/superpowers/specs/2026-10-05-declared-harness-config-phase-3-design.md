# Declared harness configuration — Phase 3

**Status:** proposed, 2026-10-05
**Parent spec:** `2026-10-04-declared-harness-config-design.md` — this is a **delta**. It does not
re-argue the model, the registry, the policies, the refusals or the scope rules. Read the parent
for those; read this for what it does not decide.
**Shipped before this:** Plan 1 (observe, PR #663) and Plan 2 (apply, PR #666), both merged and
deployed to `infra` on 2026-10-05.

## 1. What is left, and why it was left

The parent spec's §7 names four settings to fold in and §8 names a console panel. Plan 2
deliberately shipped neither: folding in is **regression work on four shipped verbs** under a
byte-identical guarantee, which is a different risk class from building a writer, and the console
is a different surface again.

Verifying the deployment then surfaced a third thing nobody had filed. The parent spec's **D6**
("an explicit operator opt-out wins") is fully honoured in code — `planFor` refuses, `applyFor`
refuses, `compare()` reports `opted-out` — but `optOut` and `clearOptOut` are called **only from
tests**. There is no route and no CLI verb, so an operator cannot create an opt-out at all. A
guarantee nothing can invoke is not a feature.

## 2. Two facts that shape the fold-in, both found by reading the code

**F5 — the `hermes-skills` writer is in the wrong package to be reused.** `skills.external_dirs`
is written by `apps/node-agent/cmd/agentpod-node/hermes_skills.go`. Go forbids `internal/...`
importing `cmd/...`, so `internal/descriptor` cannot call it. Folding in that setting therefore
requires **extracting the writer into `internal/` first**, as its own change, with its own
byte-identical proof. It is not a registry entry plus a delegation; it is a refactor and then a
registry entry.

**F6 — OpenClaw's document is JSON, so `configedit` does not serve it.** `configedit` is a YAML
line editor; `hooks.allowConversationAccess` lives in `~/.openclaw/openclaw.json` and is written by
`internal/openclawerrors/config.go`. The parent's **D5** ("parse to decide, edit as lines… comments,
ordering and formatting are the operator's") still binds, and JSON having no comments does not make
key order free. So the OpenClaw fold-in **delegates to `openclawerrors`' existing writer** rather
than teaching `configedit` a second format — and that means implementing `ConfigManager` on the
OpenClaw descriptor, not only on Hermes.

## 3. Decisions

**D9. An opt-out is settable at station and node level, and station beats node.** The same
precedence declarations already resolve by. Fleet level is deliberately excluded: a fleet-wide
opt-out is what `fleet config unset` already means, and two ways to say one thing is how a refusal
becomes ambiguous. The register is keyed on the **station key**, not the row id, so an opt-out
survives unadopt and re-adopt — a station that an operator exempted does not quietly become
eligible because somebody removed and re-added it.

**D10. A post-write containment failure preserves both edits and writes neither away.** When a
write succeeds and the post-write `SameOutsideKeys` check then fails, the document changed under
us mid-write. Reverting would discard whatever arrived in that window — possibly an operator's own
"Allow always" from seconds earlier, which is the exact loss **F2** exists to prevent. Recording
and walking away loses our intended content instead. So:

- the file on disk is left **exactly as found**;
- our intended version is written beside it as `<name>.agentpod-rejected`;
- the refusal names both paths and says plainly that neither edit has been lost.

The sidecar is overwritten by a later rejection for the same document, and never read back by this
system — it exists for a human, not for a retry. This is the only place in the design that writes a
file the harness does not own, and it does so precisely because the alternative is destroying
somebody's work.

**D11. The native harness opt-out reaches the hub as a field on `ConfigValue`.** Plan 2 left this
out on purpose: `compare()` is pure and `ConfigValue` carried no opt-out signal, so a
`plugins.disabled` entry was structurally invisible, and inventing a field for a case nothing
exercised would have been speculation. Phase 3 is where it stops being speculative — the only
native opt-out any harness has is `plugins.disabled`, and it governs exactly the plugin settings
being folded in. `ConfigValue` gains:

```ts
/**
 * The HARNESS's own record that an operator disabled this — Hermes'
 * `plugins.disabled`. Distinct from the hub's opt-out register (D9): this one
 * is the operator speaking through the harness's own UI, and agentpod never
 * writes it.
 */
optedOutByHarness: z.boolean().optional(),
```

A station reporting it reads as `opted-out` with a reason naming the harness as the source, so an
operator can tell "I exempted this in agentpod" from "I disabled this in Hermes". Both refuse a
write; only the second is invisible until you look at the document.

**D12. Folding in delegates to the existing writer, and is byte-identical or it does not happen.**
The parent spec's §7 already says this; what Phase 3 adds is the mechanism. Each folded-in registry
entry calls the same function the `apn` verb calls — it does not reimplement the edit, and it does
not become the new home of the logic while the verb becomes a wrapper. Both callers stay, and the
test is `§10.9`: byte-identical output to the verb it replaces, on the same fixture. A fold-in whose
output differs by a byte is abandoned, not reconciled.

`ErrDisabledByOperator` surfaces as `opted-out` (D11) and `ErrConflict` as a refused plan, keeping
the meanings `hermeslive/config.go` already gives them.

**D13. The console panel reads and reviews; it does not invent a second apply path.** Spec §8's
panel sits beside the existing raw editor, which stays unchanged for everything unregistered. Apply
from the panel goes through the same plan → digest → apply the CLI uses, against the same routes.
The panel must never offer an apply that did not come from a plan it displayed, because the digest
is the record that a human saw the edit.

## 4. Scope, as three plans

Phase 3 is **not one plan.** The three parts fail independently and a reviewer should be able to
reject one while approving its neighbours.

**Plan 3a — the opt-out surface.** Routes for set/clear/list at station and node level, the
`fleet config opt-out` verbs, and D9's precedence. Smallest, and it closes a hole in something
already shipped and deployed. No harness is touched.

**Plan 3b — the node write path and the fold-in.** In order, because each step's risk differs:
1. **D10's sidecar.** Node-side write-path work, in the same package as everything below it, and
   independent of the fold-in — so it lands first, while the implementer is already in that code.
2. Extract the `hermes-skills` writer from `cmd/` into `internal/` (F5), byte-identical, no new
   behaviour.
3. `ConfigValue.optedOutByHarness` and the `opted-out`-from-document path (D11).
4. The three Hermes settings — `plugins.enabled`, `plugins.stream_reasoning_deltas`,
   `skills.external_dirs`.
5. `ConfigManager` on the OpenClaw descriptor and `hooks.allowConversationAccess` (F6).

**Plan 3c — the console panel.** D13. Depends on nothing in 3b; can run in parallel with it if
somebody wants, but not by the same implementer.

## 5. Residuals from Plan 2, assigned

| residual | where it goes |
|---|---|
| post-write containment failure has no rollback | **Plan 3b, step 1** — D10 decides it; node write-path work, so it cannot sit in 3a |
| no FK on `applied_harness_config.station_id` | **Plan 3a** — a migration plus a regenerated snapshot |
| two manual adopts of one station interleave | **deferred, with a note.** Needs per-station serialization, a primitive the hub does not have; both symptoms clear on the next adopt |
| a bare `approvals:` header refuses | **Plan 3b** — one more branch in `walkMappingParents`, alongside the fold-in's own section work |
| `fleet config plan` has no single-setting selector | **Plan 3a** — a flag on an existing verb |
| `approvals.*` restart necessity unverified | **not a plan.** Needs a live experiment on a host running Hermes; the registry's `true` is the safe default meanwhile |

## 6. What has to be true before 3b can be verified against anything real

`config.manage` is advertised by **0 of 53 stations** today, because `configManagement` is a
per-node flag (`internal/config/config.go`) that Plan 1 shipped off. Until an operator enables it on
at least one node and restarts that node-agent, every fold-in is verifiable only against fixtures.

Fixtures are not enough for this particular work: the whole point of §10.9 is that the output
matches what the shipped verb produces on a **real** profile, and the four settings being folded in
are ones live stations already have values for. So enabling the flag on one node is a precondition
of Plan 3b's acceptance, not an afterthought — and the node with the fewest consequences should be
chosen, not the one with the most agents.

## 7. Testing

The parent spec's §10 still binds. Phase 3 adds:

1. **Byte-identical, per setting** (§10.9). For each folded-in setting, the registry path and the
   `apn` verb produce identical bytes from the same fixture. Not "equivalent YAML" — identical
   bytes, because D5's whole claim is that formatting survives.
2. **A sidecar is written, and the original is not touched** (D10). Assert both: the document equals
   its pre-write content byte-for-byte, and the sidecar holds what we meant to write.
3. **A harness opt-out and a hub opt-out are distinguishable** (D11). Two stations, one exempted
   each way, reporting reasons that name different sources.
4. **An opt-out survives unadopt and re-adopt** (D9).
5. **Station beats node** for opt-outs, with a test that fails if the precedence is reversed.
6. **Every predicate is revert-proofed.** Seven tests across Plans 1 and 2 turned out unable to
   fail — one asserted a property the validator strips anyway, one passed with its predicate
   stubbed to nil, one passed while the code under test was actively broken, two had fixtures
   placing the interesting shape where the code never looked. For every test guarding a decision in
   this spec: revert the production change, watch the test fail, restore it, and record that you
   did. A green suite is not evidence until something has watched it go red.

## 8. What Phase 3 does not do

- **It does not restart a harness.** D4 is unchanged and unconditional.
- **It does not write credentials** (§9's `CREDENTIAL_PATH`).
- **It does not reconcile on a tick.** D3 is unchanged: adopt writes, everything after is reported.
- **It does not add a fleet-level opt-out** (D9).
- **It does not teach `configedit` JSON** (F6). OpenClaw is served by delegation.
- **It does not fold in `pi-errors`.** The parent spec excludes it: it installs a file, not a config
  key, and does not belong in a settings registry.
- **It does not settle whether `approvals.*` needs a restart.** That needs a live Hermes host.
