---
title: Nodes
description: Running the node agent day to day — service control, logs, status, updates, and removing a node from the fleet.
---

A node runs one background service. We'll check it, control it, read its logs, and update it without
losing sight of which actions affect only the service and which actions change the fleet.

Every command on this page is a **node verb**: it acts on *this machine*. Each also has an
explicit spelling — `apn status` and `apn node status` are the same command. The bare forms
are kept because existing runbooks name them.

## Is it working?

```sh
apn status
```

Two blocks. **Local**: whether the service is installed, enabled and running, with its PID,
the binary version and the config path. **Hub**: whether the hub is reachable and the
stored credential is still valid.

The exit code is `0` only when the service is running *and* the credential is valid, so
this drops straight into a health check. Add `--json` for scripts.

You now know whether both sides agree: the output separates the local service state from the hub's
answer, and the exit code says whether both checks passed.

## Starting and stopping

```sh
apn start      # enable and start
apn stop       # stop and disable
apn restart    # restart in place
```

`apn stop` is **sticky**: it disables the service as well as stopping it, so it will not
come back on its own after a reboot or a fresh login. `apn start` is the exact inverse — it
re-enables and starts. This is deliberate; a "stop" that silently undoes itself overnight
is worse than no stop at all.

Underneath, macOS uses `launchctl` and Linux uses `systemctl`.

`start` and `stop` leave the service enabled or disabled for the next boot or login. `restart`
refreshes the running service without changing that persisted choice.

## Logs

```sh
apn logs          # recent
apn logs -f       # follow
apn logs -n 200   # last 200 lines
```

On macOS this reads `~/Library/Logs/agentpod-node.log`. On Linux it hands off to
`journalctl`.

You are reading the platform's real service log, so the next error you diagnose is the one the
resident node actually emitted.

## Installing and removing the service

```sh
apn service install
apn service uninstall
```

`install` writes a launchd plist or a systemd unit from a template embedded in the binary,
then enables and starts it. It is idempotent — running it again replaces the file and
restarts.

Where it installs depends on who you are. Non-root Linux gets a `--user` unit; root Linux
gets a system unit; macOS always gets a LaunchAgent and **refuses to run as root**.

`uninstall` stops, disables and removes the unit. It is idempotent too, and it leaves your
config and enrollment alone — uninstalling the service does not un-enroll the machine.

After either command, the service definition matches your request while the node's enrollment stays
intact.

## Running in the foreground

```sh
apn run
```

This is what the service runs under the hood. Run it directly when you are debugging and
want the output in front of you.

The node is now running in your terminal, with its output available for the debugging session.

## Updating

```sh
apn update --check    # report current and latest, change nothing
apn update            # update
apn update --force    # update even if already latest
```

On success the service restarts automatically. If that restart fails, the binary has
already been swapped — the command tells you so and prints how to restart by hand, rather
than leaving you to guess which half happened.

After `--check`, you know whether an update is available and nothing has changed. After an update
succeeds, this node is on the latest release and its service is running again.

## Enrolling again

```sh
apn enroll --hub https://hub.example.com --token <TOKEN>
```

Falls back to `$AGENTPOD_HUB_URL` and `$AGENTPOD_ENROLL_TOKEN` when the flags are omitted.

Running it on a machine that is already enrolled is a no-op, unless the stored credential
has stopped being valid or you pass `--force`.

The machine now has a valid enrollment for the hub you named; repeating the command leaves a good
enrollment alone.

## Removing a node from the fleet

A machine you retire does not leave the fleet on its own; uninstalling the service only
stops it. To take it off the list, remove it from the hub — from the node's page in the
Console (**Remove node**, confirmed by typing its name), or with `fleet`:

```sh
fleet nodes rm build-01           # a node that is offline
fleet nodes rm build-01 --force   # a node that is still connected: disconnect it too
```

Removal unregisters every station on the node, the same way **Remove station** does, and
revokes the node's credential. If the machine dials back, the hub refuses it, and
`apn enroll` with its old token fails too: to join again it needs a fresh token from
`fleet invite`. Nothing on the machine itself is touched — workspace files stay, and the
node agent keeps running until you `apn service uninstall` it.

Two kinds of node are refused, each with the command that does apply:

- **A provisioned runtime's node** goes with its runtime: `fleet runtimes rm <id>` destroys
  the container and removes the node.
- **A node where a bridge agent runs** keeps its roster row, which holds a credential, until
  you remove it on purpose with `fleet bridge rm <key>`.

The hub records each removal in its admin audit log.

The node is now gone from the fleet and cannot reconnect with its old credential, while its local
workspace remains exactly where you left it.

## Next

- [Stations](/use/stations/) — what lives on the node
- [apn and fleet](/use/cli/) — the `fleet` client, which acts as *you* rather than as the machine
