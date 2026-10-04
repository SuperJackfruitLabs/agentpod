---
title: What you can do to a station
description: The panels — files, logs, terminal, config, health, lifecycle, cleanup, changesets, skills, voice and activity — and what each one requires.
---

Open an adopted station in the console and you get a set of panels. Which ones appear
depends on what the station declares it can do.

## Capability gating

Several operations are gated on a capability the station declares:

| Capability | Gates |
|---|---|
| `fs.write` | Writing to the filesystem |
| `terminal` | The interactive shell |
| `lifecycle` | Start, stop, restart |
| `cleanup` | Planning and applying a disk reclaim |
| `changeset` | Reading the working-tree diff |

A request for a capability the station has not declared is refused **at the hub, without
contacting the node**. Reading is not gated this way — the read paths are available
wherever the station supports them.

## Files

Browse the tree, preview a file, jump straight to a path with quick-open, and edit where
`fs.write` is declared.

Under the hood these are the node's own verbs — `fs.list`, `fs.read`, `fs.write`,
`fs.mkdir`, `fs.move`, `fs.delete` — executed on the host by the local agent, never by the
hub reaching in.

## Logs

Tail the harness's logs live. The node knows where each harness keeps them, because the
descriptor for that harness knows.

## Terminal

A real interactive shell on the host, brokered through the hub. Requires the `terminal`
capability.

## Config

Read and edit the harness's own configuration file, in place and in its own format —
AgentPod does not convert it to something else and hand it back.

## Health

What the station reports about itself, asked live. The console shows this next to the
node's own online/offline state, which is a different question: a node can be perfectly
online while a station on it is not.

## Lifecycle

`start`, `stop`, `restart`. Requires the `lifecycle` capability.

Every lifecycle action is written to the audit trail **before** it is dispatched, not
after. An action that is attempted and fails still leaves a record — an audit log that only
lists successes is one that hides exactly the events you most need.

The response is the station's health *after* the action, so you can see the result rather
than assume it.

## Cleanup

Two steps, deliberately:

```
POST /api/stations/:id/cleanup/plan     what would be removed, and how much it frees
POST /api/stations/:id/cleanup/apply    do it
```

The plan is shown to you first. Nothing on disk is touched until you apply it. Requires the
`cleanup` capability.

## Changesets

What the agent has actually changed in its working tree — `status` for the summary, `diff`
for the detail. Requires the `changeset` capability.

This is the panel for the question "what has this thing been doing", answered from the
files rather than from what the agent says about itself.

## Activity

The audit trail for the station: what was done, when, and by which principal.

## Chat

Where a station has a chat identity, talking to the agent is messaging it. See
[Stations](/use/stations/#matrix-identity) for the two identity modes, and
[Talking to an agent in a room](/use/rooms/) for what else arrives there.

## Skills

What this station actually has, and the review screen for installing something. Present, eligible
and loaded are reported as separate observations rather than inferred from each other — see
[Managed skills](/use/skills/).

## Plugins

Harness plugins on this station, and reviewed changes to them: the node plans, you read the plan,
and the apply sends the digest you reviewed. Nothing here restarts the station.

## Voice notes and voice replies

Two sections, each offering *inherit*, *off*, or settings of its own, over the hub-wide defaults in
**Admin → Transcription** and **Admin → Speech**. The voice-replies section also shows which voice
this station was assigned, and lets the owner pick another. See [Voice notes](/use/voice/).

## Git identity

What this station can push to a forge as, if anything. Push access is granted per station and never
by adopting one — most stations never touch git, and a key for every station is an account nobody
uses and a key nobody revokes.

The keypair is generated **on the node**; the private half never leaves it and the hub holds no
secret. Granted and revoked with `fleet stations grant-push` / `revoke-push`.

## Posture

A banner surfaces exposure problems found on the host — the same checks
[`apn scan`](/use/scan/) runs locally.

## Next

- [Attaching an editor](/use/acp/) — your own editor against a remote station
- [Managed skills](/use/skills/) — the review model behind the Skills panel
- [Talking to an agent in a room](/use/rooms/) — the other half of a station
- [Checking for exposure](/use/scan/)
