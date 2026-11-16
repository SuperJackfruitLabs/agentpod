# Explicit Hermes task-worker adapter

**Description** — source: [`hermes.go`](../apps/node-agent/internal/superbench/hermes.go),
[`hermes_unix.go`](../apps/node-agent/internal/superbench/hermes_unix.go), and
[`worker entry`](../apps/node-agent/cmd/agentpod-bench-worker/main.go).

The private `agentpod-bench-worker` binary accepts an opt-in payload mode:

```sh
agentpod-bench-worker hermes-v1 \
  --executable /absolute/path/to/hermes \
  --home /absolute/payload-owned/home \
  --provider explicit-provider --model explicit-model
```

No dispatcher selects this mode automatically. It consumes the existing worker
stdin JSON object `{ "binding": {"board_id":"…","card_id":"…","run_id":"…","epoch":1}, "prompt":"…" }`
(up to 64 KiB, mandatory EOF, no unknown/duplicate fields). It requires an already
prepared, physically resolved home, private `.hermes` and `tmp` directories, and
an owned private regular `.hermes/config.yaml`. It never copies a user's home,
reads Node-private contexts, installs Hermes, or provisions credentials. Home
existence is a prerequisite, not proof of authentication or provider readiness.

The child environment is rebuilt from a fixed PATH (`/usr/local/bin:/usr/bin:/bin`),
locale, HOME, HERMES_HOME, and TMPDIR. No ambient coordinator, reporter, Node,
provider, loader or Hermes routing variables are forwarded. Provider credentials,
if needed, must be deliberately configured separately inside the payload-owned
Hermes profile; no existing user's credentials are copied. Hermes itself can load
its configured profile, managed policy, or installation-specific environment;
that deployment behavior and access to its executable/interpreter/dependencies
must be reviewed before enabling it. An explicit executable is not searched on
PATH: its interpreter and tools must be accessible to the actual payload UID.

The adapter invokes `hermes chat --query-file - --oneshot --format stream-json`
with explicit provider/model flags. Its query includes the original prompt and
exact binding/result instructions. It accepts only a complete bounded JSONL
stream (1 MiB total, at most 4096 events), successful process exit, successful
terminal result, and terminal text containing one strict grouped WorkerResult:
`version: agentpod.superbench-worker.v2`, the exact input binding, `outcome` of
`complete`, `blocked`, or `failed`, and a string-valued `handoff` object. Normal
prose, foreign bindings, missing/duplicate terminals, error results, replay gaps, truncation,
oversize output, and nonzero exits produce no result on stdout. Null values in
nonterminal tool arguments are permitted; terminal result validation remains
strict.

Logs go to stderr. Stream-event logs contain only event type, tool name, and
byte counts for tool input/output or assistant text. Input counts measure the
JSON-encoded argument value. Raw tool arguments, tool output, assistant text,
session IDs and terminal result text are not copied into these event logs.
The child's own stderr is forwarded separately, bounded to 64 KiB; it can contain
Hermes diagnostics and is not content-redacted. Exceeding that stderr cap or the
1 MiB stream cap refuses the task without emitting a worker result.
The result remains task evidence; it proves neither fencing nor checkpoint,
release, or board settlement. Cancellation stops the child leader; the supervising
producer must independently fence descendants before publishing evidence.

This adapter follows the inspected Hermes `chat` stream-json protocol. Different
Hermes versions may refuse or emit incompatible events and will fail closed.
The adapter and synthetic-child tests do not establish installed Hermes access,
provider connectivity, registered-layout admission, or a successful live task.
