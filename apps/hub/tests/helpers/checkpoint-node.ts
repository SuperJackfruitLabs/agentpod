/** Typed Node observations for the real Hub/PG/broker integration tests.
 * These bytes test Hub joins, not execution or remote fencing.
 */
import { BenchCoordinatorCompletion, benchCoordinatorBindingDigest } from "@agentpod/contract";
import corpus from "../../../../packages/contract/src/fixtures/bench-coordinator-v1.json";
import type { RetainedCheckpointAttempt } from "../../src/services/bridge/checkpoint-ledger";

export async function checkpointNodeObservation(attempt: RetainedCheckpointAttempt) {
  const fixture = corpus.responses.find((entry) => entry.name === "completed");
  if (!fixture || !("completion" in fixture.value)) throw new Error("missing checkpoint fixture");
  const completion = BenchCoordinatorCompletion.parse(structuredClone(fixture.value.completion));
  const b = completion.source.binding;
  b.identity = structuredClone(attempt.request.identity);
  b.host_id = attempt.profile.target.host_id;
  b.worker_sha256 = attempt.profile.target.worker_sha256;
  b.members = attempt.profile.repositories.map((pin) => ({ name: pin.name, repository_sha256: pin.repositorySHA256,
    task_ref: "refs/heads/card/" + b.identity.card_id, object_format: pin.objectFormat,
    commit: "e".repeat(pin.objectFormat === "sha1" ? 40 : 64) }));
  b.sources = b.members.map(({ object_format: _format, ...source }) => source);
  b.checkpoint.members = b.sources.map(({ name, commit }) => ({ name, commit }));
  b.checkpoint.seal = "4".repeat(attempt.profile.repositories.find((p) => p.name === attempt.profile.checkpointRepository)?.objectFormat === "sha256" ? 64 : 40);
  completion.source.checkpoint_repository = attempt.profile.checkpointRepository;
  completion.source.binding_sha256 = await benchCoordinatorBindingDigest(b);
  completion.service.checkpoints = b.sources.map((member) => ({ ...member, commit: "1".repeat(member.commit.length) }));
  completion.service.seal_commit = b.checkpoint.seal;
  completion.task.binding = { board_id: b.identity.board_id, card_id: b.identity.card_id, run_id: b.identity.run_id, epoch: b.identity.epoch };
  return BenchCoordinatorCompletion.parse(completion);
}
