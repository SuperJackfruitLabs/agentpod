# AgentPod Documentation

AgentPod is a **fleet/facilities console for agent runtimes** — see the root
[README](../README.md) for the product overview and architecture (node-agent → hub → console).

## What kind of document is this?

Documentation in this repo drifts because most of it is prose nobody checks. Everything here
is therefore one of three kinds, and **says which it is** at the top. When you add a
document, decide which kind it is first; if you cannot, it is probably the wrong document.

| Kind | Means | Where it lives | How it stays true |
|---|---|---|---|
| **Checked** | A claim a test or CI enforces. | Beside the code, or as a fixture | It fails when it is wrong |
| **Dated decision** | What was decided, when, and why. Does **not** claim to be current. | [`strategy/`](./strategy/), [`superpowers/`](./superpowers/) | It carries a date and is never edited to look current |
| **Description** | Everything else — how to do a thing, what a thing is. | Next to the code it describes; [`OPERATING.md`](./OPERATING.md) / [`DEPLOYMENT.md`](./DEPLOYMENT.md) for operators | Cheap to re-verify against the code, and cites files so re-verifying is cheap |

**A description far from its code with no check is the failure mode.** Everything found wrong
in the 2026-08-14 audit had exactly that shape. So: prefer turning a claim into a check over
rewriting it, and prefer citing `file.ts` over restating what it says.

The model for the first kind is [`fixtures/ecosystem-identity/`](../fixtures/ecosystem-identity/) —
an executable corpus that caught four real cross-repo disagreements on its first run.

## Runbooks — what an operator reads

| Document | Covers |
|----------|--------|
| [DEPLOYMENT.md](./DEPLOYMENT.md) | Deploying from scratch: VPS hub (systemd + Postgres/pgvector + nginx), console on Cloudflare Pages, node-agent images, every hub environment variable, the kaambaan bridge |
| [OPERATING.md](./OPERATING.md) | Day-2: enrolling nodes, adopting stations, driving capability panels, provisioning on Docker/Cloudflare/Modal/Fly, the kaambaan bridge ledger, troubleshooting |

## Working on the repo

| Document | Covers |
|----------|--------|
| [../CONTRIBUTING.md](../CONTRIBUTING.md) | Branch flow (trunk-based on `main`), commit style, release tagging |
| [../TESTING.md](../TESTING.md) | Running and writing tests per tier, the test-postgres requirement, conventions |
| [../CLAUDE.md](../CLAUDE.md) | Orientation for agents; per-area notes in `apps/hub/CLAUDE.md` |
| [../CHANGELOG.md](../CHANGELOG.md) | Release history (`v0.1.x`) |

## Dated decisions

[`strategy/`](./strategy/) — point-in-time arguments about where the product goes. **Read the
date.** These are proposals and decisions as of the day they were written; where one and the
code disagree, the code wins.

- [2026-08-13 — Ecosystem identity decisions](./strategy/2026-08-13-ecosystem-identity-decisions.md) — accepted; the model for this kind of document
- [2026-08-10 — The Suite: five planes, one join key](./strategy/2026-08-10-suite-strategy.md) — strategy, for discussion

[`superpowers/`](./superpowers/) — the specs and plans the work was built from, by an existing
convention: `specs/<date>-<slug>-design.md` for the design, `plans/<date>-<slug>.md` for the
implementation plan, `audits/` for point-in-time reviews. **These are records, not current
documentation** — a spec describes what was intended on its date, and is not updated when the
code moves on. Start from the founding
[fleet-console design](./superpowers/specs/2026-06-21-agentpod-fleet-console-design.md).

Also point-in-time: [RELEASE-v0.1.0.md](./RELEASE-v0.1.0.md),
[UI-UX-AUDIT-2026-06-29.md](./UI-UX-AUDIT-2026-06-29.md),
[../deploy/README-deploy.md](../deploy/README-deploy.md) (the first hub deploy; superseded by
DEPLOYMENT.md).

## Research

[`research/`](./research/) — era-independent reference material about the wider world, not
about this codebase: the [multi-agent ecosystem survey](./research/multi-agent-ecosystem/)
(protocols, frameworks, governance), sandbox patterns, an autonomy PoC.

## Archive

[`archive/`](./archive/) — **historical only.** 123 documents describing the pre-pivot
OpenCode product, which no longer exists in this repo. Nothing in there is guidance; see
[archive/README.md](./archive/README.md).
