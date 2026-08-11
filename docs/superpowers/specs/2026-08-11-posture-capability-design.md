# `posture` capability — design

**Status:** approved 2026-08-11
**Horizon:** 1 (`docs/strategy/2026-08-10-suite-strategy.md`)
**Follow-ons filed:** [#237](https://github.com/rakeshgangwar/agentpod/issues/237) config-editor validation + credential guard, [#238](https://github.com/rakeshgangwar/agentpod/issues/238) node config editing

## Problem

`apn scan` shipped in v0.1.19 as a hubless one-shot report. Horizon 3 ships continuous
posture with staged remediation. Nothing joins them: today, knowing whether any of
thirty-nine stations has exposed credentials means SSHing to each machine in turn.

The roadmap line — *"a `posture` capability alongside health and logs"* — assumed this was
a presentation problem. It is not. **Checking the scanner against the real fleet found
three correctness bugs.** Surfacing its findings as they stand would publish wrong answers
to the whole fleet.

## What the investigation found

Verified 2026-08-11 against `molt-bot` (Hermes, 15 profiles, via `46.225.24.70` — its
Tailscale route showed offline while the public route worked), `superchotu` (OpenClaw, 12
agents) and this Mac (claude-code, codex, opencode).

### Bug 1 — false pass: the paths are wrong

`CredentialPaths` names files that do not exist:

| Harness | Scanned | Reality |
|---|---|---|
| `openclaw` | `config.json`, `credentials.json`, `gateway.json` | **0 of 3.** Real: `openclaw.json` (Mac), `.env`, `gateway.systemd.env`, `credentials/*.json` (superchotu) |
| `hermes` | `config.json`, `credentials.json` | **0 of 2.** Real: `config.yaml`, `auth.json`, `.env` |
| `claude-code` | `.claude/.credentials.json`, `.claude.json` | 1 of 2 — the first is absent (macOS Keychain) |
| `codex` | `auth.json`, `config.toml` | 2 of 2 ✓ |
| `opencode` | `auth.json` | 1 of 1 ✓ |

`apn scan` on this Mac reports **grade A, "Nothing exposed, nothing world-readable"**
having never opened the file holding the OpenClaw config. The two wrong harnesses are the
two composite ones.

This is the severe bug. The package's own doc forbids it: *"a false pass, which is the one
outcome a scanner must never produce."*

### Bug 2 — blind spot: per-station credentials are never checked

Confirmed, not hypothesised. `MatrixIDFromProfile` reads `auth.json` from each profile
directory, and its comment notes it ignores the other fields *"including access_token"*.

- Hermes: `profiles/<name>/auth.json` (600) and `profiles/<name>/.env` (600), per profile
- OpenClaw: `agents/<name>/agent/{auth.json,auth-profiles.json,auth-state.json}` (600)

`Finding.Station` is declared in the struct and assigned nowhere. These are what it is for.

### Bug 3 — false alarm: file mode is not exposure

Latent today, and **activated by fixing bug 1**. On molt-bot:

```
755  /
700  /root                                   ← nobody else can traverse
700  /root/.hermes
755  /root/.hermes/profiles
700  /root/.hermes/profiles/analyst-echo
644  /root/.hermes/profiles/analyst-echo/config.yaml
```

That `config.yaml` is world-readable by mode and unreachable in fact. `worldOrGroupReadable`
inspects only the file's own bits. Correct the paths without correcting this and molt-bot
alone yields 15 false criticals — one per profile — grading a properly secured box **F**.

A scanner that cries wolf gets ignored; the package doc says so. Bugs 1 and 3 must land
together.

## Design

### 1. Correct the path map

Rebuilt from observation. Every entry carries a comment naming the machine it was verified
on and the date — assumption is what produced bug 1.

```
hermes:      .hermes/config.yaml, .hermes/auth.json, .hermes/.env
openclaw:    .openclaw/openclaw.json, .openclaw/.env,
             .openclaw/gateway.systemd.env, .openclaw/credentials/*.json
claude-code: .claude/.credentials.json, .claude.json
codex:       .codex/auth.json, .codex/config.toml
opencode:    .local/share/opencode/auth.json
```

Entries may be globs (`credentials/*.json`); today's map holds literal paths only, so the
lookup grows glob expansion. A glob matching nothing behaves exactly like an absent literal.

A path that does not exist stays silent — absence is not a finding. A path that exists but
cannot be stat'd reports `StatusUnknown`, never `pass`.

### 2. Effective reachability

A finding is real only if another user can actually reach the file. Walk from the file to
the filesystem root; if any ancestor denies `o+x`, no other user can traverse, and the file
reports **pass** whatever its own mode says. The group case is the same test against `g+x`,
evaluated separately because a file can be group-exposed without being world-exposed.

This is a distinct function with its own tests, because it is the difference between a tool
that gets trusted and one that gets muted.

### 3. Per-station credentials

Profile directories are discovered by globbing (`profiles/*`, `agents/*`), never by
hardcoded names. Each finding sets `Finding.Station` to the station key the descriptor
already produces for that profile — `hermes:<name>` and `openclaw:<name>`, matching
`hermes.go` and `openclaw.go` exactly — so the console joins a finding to a station by
equality rather than re-deriving the key. The two must not drift; a test pins the format
against the descriptors.

Only composite harnesses have per-station credentials. claude-code, codex and opencode
contribute node-level findings only.

### 4. Directory modes

`agents/<name>/` is `775` on superchotu — group-writable. Anyone in the group can *replace*
an agent's `auth.json`, which no file-mode check can see and which is arguably worse than
reading one. Config directories get a mode check of their own, reusing the same reachability
walk.

## Surfacing

### Node capabilities

`nodes` has no capability concept — `stations.capabilities` is a station column. A
node-level verb has nowhere to declare itself.

Add `capabilities` to the **`hello` frame** the node already sends on connect, stored in a
new `nodes.capabilities` column. Absent → null → no tab, so old nodes degrade silently.

Two reasons for the handshake rather than a new verb: `HelloMsg` already has a Go drift
fixture, so the contract change inherits that test; and **node capabilities refresh on every
connect by construction**. The staleness bug fixed for stations in the changeset work
structurally cannot occur here.

### Verb

`posture.scan`, node-level, taking `{}` and returning the graded `Report`. It runs the scan
live; nothing is stored. Same observe-only line drawn for `changeset`, for the same reason —
stored posture history is Horizon 3's continuous-posture item.

### Console

- **Node page → Posture tab**, gated on the node advertising `posture`. Grade, failures
  first with remedies inline, unknowns in their own section. Mirrors what `apn scan` prints,
  because that output is already tuned for "is anything wrong and what do I type".
- **Station page → a banner** only when a finding names that station or its harness, linking
  to the node's Posture tab. No duplicated scan; one fact is not reported thirty-nine times.

### Explicitly out of scope

- No fleet-wide grade roll-up. That is N live calls or stored history — Horizon 3.
- No remediation from the console. Findings carry a remedy string; running it is Horizon 3's
  staged remediation.
- No reading of credential *contents*, ever. The scan reports modes and paths only.
- No Windows support; the reachability walk assumes POSIX mode bits.

## Testing

- **Reachability** — real temp-directory chains. The load-bearing case: a `644` file under a
  `700` ancestor must report **pass**. Also `755` ancestors with a `600` file (pass), and a
  genuinely reachable `644` (fail).
- **Fixture trees** mimicking the observed hermes and openclaw layouts, including per-profile
  `auth.json` and `.env`.
- **A regression test that fails against today's path map** — the false pass must not be able
  to return silently.
- **Absence vs unreadable** — a missing path is silent; an unstattable one is `unknown`, never
  `pass`.
- Gateway handler dispatch; hub route ladder (401/404/403/409/502); console tab gating and a
  station banner that appears only for a matching finding.

Per repo convention, every one of these is written failing first.

## Known limits

**Hermes evidence is from one machine.** molt-bot's 15 profiles were observed directly. If a
Hermes install elsewhere uses a different layout, the checks report absence rather than a
false pass — which is why absence is silent and unreadable is `unknown`.

**The credential path list is a maintenance surface.** It is correct as of 2026-08-11 and
will drift as harnesses change. That is inherent to checking real files; the mitigation is
the dated per-entry comments and [#237](https://github.com/rakeshgangwar/agentpod/issues/237)
making the same list serve a second consumer, so drift gets noticed sooner.
