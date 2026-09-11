---
title: What AgentPod is
description: A fleet and facilities console for agent runtimes — what it manages, and what it deliberately does not.
---

AgentPod manages **the environments AI agents live in**, wherever they run.

An agent needs a place to work: a filesystem, a config file, somewhere its logs go, a
process that can be started and stopped. Once you have more than one agent, on more than
one machine, that place stops being something you can hold in your head. AgentPod is the
console for those places.

It is **attach-first**. You point it at runtimes you already have and it detects them
where they sit. Nothing moves, and nothing is rewritten to a new format.

## What it gives you per runtime

- **Filesystem** — browse, read and write the workspace
- **Logs** — tail them live
- **Terminal** — an interactive shell, through the hub
- **Config** — edit the harness's own configuration file
- **Health** — whether it is up, and what it reports about itself
- **Lifecycle** — start, stop and restart
- **Cleanup** — plan a disk reclaim, inspect the plan, then apply it
- **Changesets** — what the agent has actually changed in its working tree
- **Activity** — an audit trail of what was done to the station, and by whom
- **Provisioning** — create new runtimes on Docker, Cloudflare, Modal or Fly

Not every station offers all of these. Each one is gated on a capability the harness
declares, and a station that does not declare it is refused before the request ever
reaches the machine.

## Three tiers

```
   Operator (web console)
            │  HTTPS + WSS
            ▼
   ┌───────────────────────────┐    outbound WSS tunnels (NAT-friendly)
   │       AgentPod Hub        │◄────────┬────────────┬──────────────┐
   │  (Bun + Hono + Postgres)  │         │            │              │
   │  • node/station registry  │     node-agent   node-agent    node-agent
   │  • connection broker      │     (VPS)        (laptop)      (provisioned)
   │  • enrollment + auth      │
   │  • provisioning drivers   │
   │  • audit + activity log   │
   └───────────────────────────┘
```

**node-agent** is a single static Go binary, installed per host. It dials out to the hub
and executes contract verbs locally. It opens no inbound ports, which is why a laptop
behind CGNAT is reachable at all.

**The hub** is the registry, the connection broker, and the place authentication and audit
live. It is a Bun + Hono service over Postgres, and you host it yourself.

**The console** is a static SvelteKit app: node list, then the station tree under each
node, then the panels above.

## What it is not

It is **not a harness**, and it does not run your agents. Claude Code, Codex, Hermes and
the rest do that. AgentPod manages the ground they stand on.

It is **not an orchestrator**. Deciding what work an agent should do next is a different
job in a different plane — that is what [kaambaan](https://docs.kaambaan.dev) is for.
AgentPod answers "where does this agent live, and is it healthy", not "what should it work
on".

## Next

- [Enroll your first node](/start/first-node/) — a machine in the fleet in about five minutes
- [Concepts](/start/concepts/) — nodes, stations, harnesses and principals
