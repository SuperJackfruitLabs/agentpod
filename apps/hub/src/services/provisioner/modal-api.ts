/**
 * The narrow slice of Modal this driver needs, and the one place the SDK is
 * allowed to be imported (the adapter lands in Task 2).
 *
 * The SDK is 0.x and renames parameters between minor versions — `timeout`
 * became `timeoutMs`, and an unknown key is rejected at runtime by the SDK's own
 * guard rather than ignored. Confining it to one file means a rename costs one
 * edit and one test, not an audit of the driver.
 */

/** Everything Modal needs to start one sandbox for one AgentPod runtime. */
export interface ModalCreateSandboxParams {
  /** Modal App the sandbox is grouped under. Grouping only; carries no state. */
  appName: string;
  /** Registry reference Modal pulls. Must be linux/amd64 and carry python+pip. */
  image: string;
  /** The durable anchor: created if missing, reused by every later sandbox. */
  volumeName: string;
  /** Where the volume is mounted. The workspace, and nothing else, lives here. */
  mountPath: string;
  /** Working directory of the entrypoint command. */
  workdir: string;
  /** Entrypoint argv. The image sets no ENTRYPOINT — see Dockerfile.modal. */
  command: string[];
  /** Environment. Carries the enrolment token: NEVER log this object. */
  env: Record<string, string>;
  cpu: number;
  memoryMiB: number;
  /**
   * Maximum lifetime. Modal's default is FIVE MINUTES, so omitting it does not
   * mean "no limit", it means a station that dies before its operator returns
   * from coffee.
   */
  timeoutMs: number;
}

/**
 * A resource Modal says does not exist.
 *
 * Typed rather than message-matched: the driver has to tell "already gone,
 * which is what I wanted" from "the substrate is unreachable", and destroy
 * idempotency (conformance rule 6) hangs on getting that distinction right.
 */
export class ModalNotFoundError extends Error {}

/**
 * Credentials this substrate needs.
 *
 * Declared here rather than in modal.ts because the adapter is what consumes
 * them — `requireCredentials("modal", MODAL_CREDENTIAL_KEYS, resolver)` in
 * createModalApi() — and because the driver imports this file: a constant
 * pointing the other way would make the two modules import each other.
 *
 * Both keys, not one. Modal's tokens are a pair and requireCredentials() names
 * every missing key at once, so a hub deployed with half the pair is refused at
 * startup with one message rather than one redeploy per key.
 */
export const MODAL_CREDENTIAL_KEYS = ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"];

/** The substrate, as this driver needs it. Implemented for real in Task 2. */
export interface ModalApi {
  createSandbox(params: ModalCreateSandboxParams): Promise<{ sandboxId: string }>;
  /** Irreversible. Modal has no start verb; this ends the sandbox for good. */
  terminateSandbox(sandboxId: string): Promise<void>;
  /** `null` while running, else the exit code. Throws ModalNotFoundError if forgotten. */
  pollSandbox(sandboxId: string): Promise<number | null>;
  /** Deletes the durable anchor. Throws ModalNotFoundError if already gone. */
  deleteVolume(name: string): Promise<void>;
}
