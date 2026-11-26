---
title: Remote bench stages
description: Letting a station's Hermes agent work in a card's bench over SSH, what it needs, what happens on a card, and what an operator does when a bench is held.
---

A bench stage normally runs its work as one task on the bench host (`one-shot`). A **remote**
stage instead lets the station's own agent work in the card's bench: the agent stays on its node,
and its terminal and file tools reach the bench over SSH, through a short-lived certificate the
bench host issues for the card's lease. When the agent ends its turn, the bench is checkpointed and
the card settles the same way a one-shot stage settles.

Remote stages work with Hermes stations only.

## Setting one up

```sh
fleet bench stage set NAME --execution remote --bench-node NODE --repin
fleet bench doctor NAME
```

`NODE` is the node on the bench host. It must advertise `bench.remote.credential`, and the
station's node must advertise `bench.remote.attach`. The station's node and the bench node can be
the same machine. The printed `checkpointPolicy` still names the bench node as `nodeId`.

Switching a stage to `remote` clears its worker and worker arguments. Switching back needs
`--execution one-shot --worker PATH [--worker-arg A ...] --launch registered-v1`.

### Before the first card

- **`--repin` after every node binary change.** The stage's registry pins the node's own binary.
  After an update, `stage set` refuses with `coordinator_pin` until it is repinned, and `doctor`
  reports `the node's registry is not served (coordinator_pin)`.
- **The `agentpod-live` plugin, 0.3.0 or later, in the station's Hermes profile.** An attach
  refuses with `plugin_missing` without it. While a station is attached, the plugin rewrites
  replace-mode `patch` calls to V4A patches and adds a short note to the system prompt, because
  Hermes builds a replace-mode edit's approval diff from a file on its own machine.
  - For a station with a **named** profile (`~/.hermes/profiles/NAME`) on a Hermes inside the
    plugin's tested range, install it with `apn hermes-live enable --profile NAME --apply`, then
    restart the gateway.
  - The Console's plugin panel is the other route. It needs `"pluginManagement": true` in the node's
    configuration, and a principal that may change the station. It goes through the same Hermes
    version check as `apn hermes-live`.
  - That check refuses a Hermes outside the plugin's tested range (today, newer than 0.21.5, so
    0.23.x is refused). It also refuses a Hermes installed from a git checkout in editable mode,
    which reports its version as `0.0.0`.
  - **Not built yet:** `apn hermes-live` only handles named profiles. A station whose profile is the
    Hermes root (`~/.hermes`) has no supported install path today, and neither does a Hermes the
    version check refuses.
- **No credential files.** Hermes copies a profile's credential files to the remote side, and its
  own deny-list does not cover the profile's configuration list. An attach therefore refuses with
  `credential_files` when:
  - `terminal.credential_files` is not empty, or
  - **any** skill under the profile's `skills/` declares `required_credential_files`, whether or
    not it is enabled. A stock Hermes install includes one (`productivity/google-workspace`).
    Move such a skill out of `skills/` for a station that serves a remote stage.

## What happens on a card

1. **Attach.**
   - The station's node holds one SSH key for the station and sends the hub only its public half.
   - The bench host's node asks SuperBench for a certificate bound to the card's lease.
   - The station's node pins the bench's host key and points the station's terminal at the bench.
     The terminal's working directory is the card's workspace root.
   - The pin goes in the `known_hosts` file that ssh itself names for the bench (`ssh -G`, as the
     node's user), so it holds whatever `$HOME` or the user's ssh configuration say. When ssh names
     no file a pin can live in (`none`, `/dev/null`, a symlink, or a `HostKeyAlias` for the bench),
     the attach is refused `unavailable` and nothing is written.
   - No certificate, private key or lease token is stored by the hub.
2. **The turn.**
   - The hub opens a fresh ACP session after the attach, with the workspace root as its working
     directory.
   - The agent's own end of turn means "done". The agent commits its work in the workspace's
     repositories and does not push.
   - The hub renews the certificate when less than ten minutes remain. It heartbeats the run only
     while the agent is alive and its node still holds the attachment.
3. **Finish.**
   - The bench host's node checkpoints the bench, stops and releases the lease, and the card
     settles. Its `execution.id` is SuperBench's remote execution.
   - A tree with uncommitted or untracked files is refused. The agent is attached again in a fresh
     session and asked, twice, to commit or remove them, with SuperBench's own message. After that
     the run fails (`remote.dirty`).
4. **Detach.** The station's terminal configuration and `known_hosts` go back to the bytes they had
   before the attach. A `known_hosts` (and `~/.ssh`) that the attach created is removed again.

The turn's time limit is the stage task's timeout, 30 minutes. It counts from the first turn,
across hub restarts and dirty-tree retries. Work longer than that is cut off and the run is
reclaimed.

Questions work as on any stage. In `ask` or `accept-edits` mode, a permission request the mode
does not answer is asked on the board. The turn waits up to the roster row's permission wait for
the answer.

While a station is attached to a bench, resuming its turn after a hub restart, or retiring its
attempt, closes **every** session on that station. That includes a workspace admin's Console chat.

### Other sessions on the station

Hermes reads a profile's terminal when a session opens. A session opened while the station is
attached would therefore work in the card's bench, beside the stage's own agent. So, from the
card's claim until the station is detached, the hub opens no other session on the station:

- A Console chat is refused with "This station is working in a card's bench; try again when the
  stage finishes."
- A Matrix room's message gets the same sentence as a notice, and no session opens. The room's
  next message after the stage opens a session as usual.
- An editor connected through the ACP proxy gets the same refusal.
- Board work for another card waits, as it does for any busy station.

**The hub cannot refuse sessions it does not open.** Hermes's own messaging platforms (its
gateway's Telegram, Discord, Slack and similar adapters) open their own sessions for the profile.
While the station is attached, those sessions work in the card's bench too, and their edits are
checkpointed with the card. Turn the gateway's messaging platforms off for a profile whose station
serves a remote stage.

## When an attempt fails or its run ends

Whatever ends the attempt (the agent's node refuses the attach, the dirty-tree limit, a lost or
crashed agent, the turn's time limit, or the card moved off the stage), the hub tells the bench
host's node. That node then frees the bench:

- **A clean tree** is checkpointed first, so the agent's commits are kept, and then the lease is
  released. The card still reports the failure; the checkpoint only frees the lease.
- **A dirty tree is never discarded.** The lease stays held, and the attempt waits with the reason
  `remote.held_dirty`.
  - The attempt keeps its station busy.
  - The card says that the bench needs an operator, with the steps below. It says so once per hub
    process, so it can say it again after a hub restart.
  - The hub logs it at warn.
  - The hub asks the bench host's node again on later passes, and never times the wait out. Once
    an operator has released the lease, the attempt ends as usual and the station is free.

### Freeing a held bench

Run these as root on the bench host. `KEY` is the card's bench key, which the card's message
names. `SOCKET` is benchd's socket, and `STATE`, `DATA`, `CGROUP_ROOT` and `TIMEOUT` are the
`--state`, `--data`, `--cgroup-root` and `--mirror-timeout` that benchd itself runs with
(SuperBench's `bench` reference, "A stopped lease that cannot release").

1. `bench workspace stop_admin --socket SOCKET KEY`. The lease stays with the attempt's holder;
   `bench workspace status --socket SOCKET KEY` shows the holder.
2. `bench workspace renew_admin --state STATE --data DATA --cgroup-root CGROUP_ROOT --mirror-timeout
   TIMEOUT KEY`. It is a local verb, with no `--socket`. It prints a renewed token for the same
   holder (`grant_token`). Keep it out of logs.
3. `bench workspace run --socket SOCKET --holder HOLDER --request-id FRESH_ID KEY -- COMMAND`, with
   the renewed token in `BENCH_LEASE_TOKEN`. The command commits or removes the stray files, for
   example `rm -f sandbox/notes.txt`. A successful run checkpoints and releases.
4. `bench workspace status --socket SOCKET KEY`. Only if it still shows the lease, run `bench
   workspace checkpoint --socket SOCKET KEY` and then `bench workspace release --socket SOCKET KEY`
   with the same token.
5. Optionally, `bench workspace reclaim --socket SOCKET KEY`. The hub reclaims the bench itself once
   the card is done, cancelled or dormant.

**Not built yet:** a SuperBench release that discards the tree back to its last checkpoint. Until
it exists, a dirty bench always needs the steps above.

### A station whose detach never confirms

An ended attempt keeps its station busy until the station's node confirms the detach. The hub's
detach sweep asks again every five minutes. A node that is offline confirms once it is back. A
node that **refuses** the detach every time (the hub logs `remote.detach.invalid` on each pass)
never does, and the station stays busy.

To free such a station:

1. On the station's node, restore the profile's terminal by hand: put back the `terminal:` section
   the attach replaced (the node's attachment journal under its config directory,
   `bench-attachments/STATION.json`, holds the original lines as `prior`), remove the managed
   `known_hosts` pair the journal names (`known_hosts` and `pinned`), and remove the
   `agentpod-bench.json` file from the profile, the bench certificate (`KEY-cert.pub`, beside the
   `key_path` the journal names) and the journal itself.
2. Record it, with what you checked:

   ```sh
   fleet bridge checkpoint-detached ATTEMPT --evidence "restored the terminal by hand; journal removed"
   ```

The hub records the detach as confirmed and the station takes work again. It asks no node and
changes nothing else, and the workspace's audit log keeps your evidence. It is refused (409) while
the attempt is still in progress (`in_progress`; settle it with `fleet bridge checkpoint-settle`
first), and for a station that is already detached or was never attached (`not_attached`). Only a
workspace owner or admin can run it.

## Known limits

- The turn's 30-minute limit is fixed; a stage cannot raise it yet.
- Hermes background processes started on the remote side end within seconds. Ask the agent to run
  long commands in the foreground, under the terminal tool's own limit.
- SuperBench's SFTP view is rooted at the workspace, while commands see absolute paths. Hermes
  never uses `scp`, so this does not affect it.
