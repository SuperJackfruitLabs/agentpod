# Does `approvals.*` take effect without a Hermes gateway restart?

**Finding: inconclusive. `RestartToTakeEffect` stays `true` for all three `approvals.*` entries.**

## What this note is answering

Spec §7 (`docs/superpowers/specs/2026-10-04-declared-harness-config-design.md:308-314`) and
Plan 1's comment in `apps/node-agent/internal/descriptor/hermes_config.go` both record
`approvals.timeout`, `approvals.mode` and `approvals.command_allowlist` as `RestartToTakeEffect:
true`, labelled **unverified**. This task's job was to replace that assumption with evidence,
or to confirm it stands.

## What was checked

1. **Hermes binary on this host.** `command -v hermes` → not found. `which -a hermes` → not
   found. No shell function or alias named `hermes` (`type hermes` → not found). Not present
   under `~/.local/bin`, `~/go/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, or
   any pipx/uv-tool venv on this host. No `hermes` or `hermes_agent` Python package importable
   (`python3 -c "import hermes"` / `import hermes_agent` both raised `ModuleNotFoundError`). No
   `/Applications` entry, no launchd/systemd user unit, no Docker image or container, no man
   page (`man hermes`, `apropos hermes` both empty).

   **Hermes is not installed on this host.** The task brief's instruction to run
   `hermes --help` or grep the binary's install directory could not be carried out — there is
   nothing to run or grep. This contradicts the brief's premise ("Hermes is installed on this
   host") for this particular worktree/environment.

2. **`~/.hermes/`.** Exists (state.db, SOUL.md, cache/hooks/sessions/skills/memories/pairing
   directories), but holds no `docs/` subdirectory and no config.yaml at the top level to
   inspect — nothing under it matched `grep -rn "approvals" ~/.hermes/docs` because that path
   does not exist.

3. **A stray scratchpad tree from an unrelated prior session**
   (`/private/tmp/claude-501/.../d0bb888e-.../scratchpad/hermes`) had directory names suggesting
   a Hermes source checkout (`gateway/`, `agent/`, `hermes_cli/`, `hermes_agent.egg-info/`), but
   it is not a git repository (`.git` present but `git log`/`git remote -v` both report "not a
   git repository"), and every directory under it is empty — zero `.py` files anywhere in the
   tree (`find ... -iname "*.py" | wc -l` → 0). It is not usable as Hermes source and is not
   cited as evidence of anything.

4. **Local worktrees named `hermes-cmd`, `hermes-skills`, `claude-hermes`**
   (`/Users/rakeshgangwar/SuperJackfruit/agent-skills-worktrees/`) are old **agentpod** feature
   worktrees (package.json name `agentpod`, branches like `feat/hermes-register-command`), not
   a checkout of Hermes' own source. Ruled out.

5. **agentpod's own accumulated knowledge of Hermes config** (what the brief calls
   "agentpod's own accumulated knowledge of how Hermes reads config"):
   - `apps/node-agent/internal/hermeslive/config.go:27-28` — a comment on the plugin-enable
     writer: *"Hermes's own `plugins entries` and `_config_version` are never touched."* This is
     about `_config_version`, Hermes' own migration bookkeeping key, and about the
     `plugins.entries` sub-tree — neither is `approvals.*`, and the comment does not speak to
     reload timing, only to which keys agentpod's writer must leave alone when it edits
     `plugins.enabled`.
   - `apps/node-agent/internal/hermeslive/observe.go:130` — `"restart the profile's gateway to
     load it"`, about a newly installed plugin not yet loaded by a running gateway. Again a
     different setting (plugin load), not `approvals.*`.
   - `integrations/hermes/agentpod-live/README.md:51` — `"It never restarts the gateway.
     Restart it from the Console..."` — about the plugin installer's own behaviour, not about
     whether `approvals.*` specifically needs a restart.
   - No file in `apps/node-agent/internal/descriptor/` or `apps/node-agent/internal/hermeslive/`
     mentions `approvals` together with `restart` or `reload`.

6. **The spec itself** (`docs/superpowers/specs/2026-10-04-declared-harness-config-design.md:84-98,
   308-314`) states the two documented reload boundaries Hermes' own docs name — hot-reload for
   `model.context_length` and `compression.*`, restart for "API keys and tool/skill config" —
   and says plainly that `approvals.*` is named in **neither** list. That is the same open
   question this task exists to close, not new evidence toward closing it; repeating it back is
   not a citation that moves the needle.

## Conclusion

No artefact — not Hermes' own source or docs (unreachable: Hermes is not installed on this
host and no doc bundle exists under `~/.hermes/`), and not agentpod's own code or docs (which
only restate the existing open question) — says whether `approvals.timeout`, `approvals.mode`
or `approvals.command_allowlist` are read once at gateway start or on every request/turn.

**The evidence is inconclusive.** Per the spec's asymmetry argument (§7): claiming a restart is
needed when it is not costs one unnecessary restart; claiming it is not needed when it is
produces a config file that says one thing while the running gateway enforces another, which is
the worse drift. Absent a citable artefact that resolves it, all three `hermes.approvals.*`
registry entries in `apps/node-agent/internal/descriptor/hermes_config.go` keep
`RestartToTakeEffect: true`. No code change was made.

## Is a live experiment the only way left?

Yes, as far as this task could determine. The remaining way to settle the question — flip a
value on a running profile's `config.yaml` and observe whether the live gateway's behaviour
changes without a restart — is exactly the live experiment this task was told not to run on its
own initiative (it would restart, or require not restarting and then probing, someone's live
workspace gateway). This note does not run it; the controller should decide whether and how to
authorise it.
