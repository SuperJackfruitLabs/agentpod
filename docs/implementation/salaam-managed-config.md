# Salaam managed configuration evidence

This implements the existing config.manage v1 shapes with additive optional
StationHealth.configurationDigest activation evidence. The unrelated
`docs/declared-harness-config-spec` work is a draft, not a silently accepted
cross-product agreement. No accepted local Charter decision specific to this
Salaam contract was located during this packet; the existing implemented v1
interface is the compatibility baseline.

Producer and consumer map:

- Salaam native `host-configuration.ts`: validates intended manifest by fresh
  native `planHost`, owns prior-byte digest, private journal, atomic apply,
  applying recovery, restart-required receipt, and saved identity replay.
- AgentPod node `descriptor/salaam_config.go` and `salaam/configuration.go`:
  unchanged ConfigManager methods delegate through the configured private Node
  and CLI. No daemon startup is called by configuration management.
- Existing Salaam private health `host_manifest_digest`, real `pid`, connected
  supervisor, healthy controls and matching Node identity become optional node
  station health `configurationDigest`. The Hub routes and adoption reconciliation
  pass this live evidence to `compare`; exact canonical manifest SHA-256 can
  establish activation despite the intentionally stopped apply-time PID. Generic
  harness null/unchanged-PID rules remain unchanged.
- Existing Salaam per-session context inventory becomes generic node
  SkillInventoryProvider output. It distinguishes current presence/admission,
  verified provider-payload loading, stale resources and unobserved exercise.
  This does not enable native automatic discovery or ACP command announcements.

Evidence at AgentPod base 533c1c37765bd53756f6fecbf85252c40bc45618:

- Full contract suite: 709 passed. DB-free comparison/typed-health/protocol batch:
  73 passed. No DB-backed Hub tests were run by this packet.
- Full descriptor and Salaam Go packages passed race detection. Later inventory,
  passive-detection and native-command additions passed targeted race checks.
- Actual disposable offline schema2 to schema3 configuration passed the real
  Go ConfigManager -> pinned Node -> Salaam CLI observe/plan/apply/inspect/replay
  path, including wrong-digest refusal. This created no daemon.
- Hub typecheck fails identically on the detached base and changed checkout:
  14 diagnostics, complete normalized compiler output identical with the same
  dependency paths and each checkout's own contract package.
- Native tests cover real CLI subprocesses, stale bytes/config pins, identity
  rebind rejection, three ownership locks, interrupted applying recovery,
  preserving unexpected bytes and another explicitly reviewed rollback plan.

All fixtures are disposable, offline, credential-free and outside existing
stations. These checks are source/local conformance evidence, not production
rollout or a live fleet result. The optional real context-inventory API test also passed against two actual
pinned Pi sessions through the running private Salaam API and Go consumer
(`/private/tmp/m22-context-go-interop.log`); it is separate from mocked transport
tests.
