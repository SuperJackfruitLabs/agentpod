# An agent's git identity is a minted token, not an account

**Status:** accepted 2026-09-27.

**Why now:** the Press board can route a card to `writer-quill` and `coder-kai`, and neither can
commit anything. Every guild station's workspace is `/root/.hermes/profiles/<name>` — a Hermes
profile directory, not a checkout — and no agent holds a git identity on any host.

## Not the forge integration, and why

`charter → decisions/2026-09-22` says agent accounts come from an agentpod integration on the
station-provisioning hook rather than being made by hand. That decision is about **Forgejo**.

forge holds **pull mirrors only**, and the same decision forbids changing that: a Forgejo push
mirror is a forced `git push --mirror` and would overwrite in-progress work on GitHub. Press
publishes to `super-jackfruit-website`, which is on GitHub. So building exactly what was described
would leave an agent able to commit nowhere.

That integration is still wanted — a deeper forge integration is on the roadmap, along with
GitHub integration for superpipeline and agentpod. This is not it, and does not foreclose it: it
is the same credential path, installed once instead of fleet-wide.

## The decision

**A GitHub App. The hub mints a short-lived installation token per station on demand; the station
never holds a long-lived credential.**

| | push | open/merge a PR | attribution | rotation |
|---|---|---|---|---|
| **GitHub App** | yes | yes | `<app>[bot]` | 1-hour tokens, automatic |
| Machine user + PAT | yes | yes | looks human | manual |
| Deploy key | yes | **no** | whatever git config says | manual |

A deploy key cannot open or merge a pull request through the API, which is precisely what the
board's `publish` stage does. A machine user makes an agent's commits look like a person's, which
is the wrong answer in a repository whose editorial rule is provenance — the blog renders its own
sources for the same reason.

Nothing in the estate writes to GitHub today: superpipeline's integration is inbound webhooks that
enrich cards (`apps/api/src/references/github-events.ts`). There is no App to extend.

## Shape

Two halves, both copied rather than re-derived — `station-matrix-credential.ts` says it took its
shape from `station-token.ts` "not re-derived", and this takes its shape from that.

**Mint.** The hub holds the App id and private key. To produce a credential it signs an App JWT
(RS256, ≤10 minutes, `iss` = app id), then exchanges it for an **installation access token**
scoped to the repositories and permissions the installation grants. That token lives one hour.

**Redeem.** A node exchanges the credential it already holds — `<nodeId>:<nodeSecret>`, proven
once at enrollment — for a token for one of ITS stations. Same refusals as its sibling: a station
that does not exist and a station hosted by another node are refused **identically**, so 403
cannot be read apart from 404 to probe station ids. The hub never logs what it minted.

**Use.** The station gets a git credential helper, not a file with a token in it. Git invokes the
helper, the helper redeems, and the token is used for that operation and forgotten. A workspace
that is cloned, copied or inspected later contains no credential.

## Why a helper rather than a token in the workspace

A turn is bounded at 30 minutes and a token lives 60, so injecting one at dispatch would usually
work — which is what makes it tempting and wrong. It would write a live credential into a
directory the agent can read, print, commit by accident, or include in a handoff. The failure is
silent and the blast radius is whatever the installation grants. A helper keeps the secret in the
process that needs it for as long as the operation takes.

## Scope

**One App, one installation, one station.** `coder-kai` gets the repository and the identity;
`writer-quill` returns its post as handoff content rather than as a commit. One identity instead
of four, and it keeps the writer away from the merge button — the separation the board's design
wanted anyway.

## What this costs

- **A private key the hub can use.** Stored encrypted at rest (`utils/encryption.ts`, AES-256-GCM,
  already used for API keys and tokens). It is the credential that mints every other credential, so
  its handling is the security boundary of this whole feature.
- **Registering the App is not automatable.** It is a GitHub setting and a secret; the operator
  does it. Everything after is code.
- **`onStationsAdopted` holds exactly one listener** ("Replaces any previous"). Fleet-wide
  provisioning later must make that a list; this scope does not touch it.

## What this does not do

- **No fleet-wide account provisioning.** One installation, registered once.
- **No forge accounts.** Deliberately — see above.
- **No push to forge.** Unchanged: mirrors only, cutover postponed.
- **No credential for a station whose node did not ask.** There is no route that hands a token to
  anyone but the node hosting that station.

## Testing

- An App JWT carries `iss`, an issued-at in the past and an expiry within ten minutes, signed
  RS256 — asserted by verifying it against the public key, not by reading the fields back.
- A redeem for a station on another node is refused with the same status and body as one for a
  station that does not exist.
- A minted token is never written to a log line, asserted on the logger rather than by reading
  code.
- The credential helper returns a usable token for `github.com` and nothing for any other host.
