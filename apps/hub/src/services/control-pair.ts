/**
 * The control pair's switch, and its refusal.
 *
 * Decision 4 of charter decisions/2026-08-13-ecosystem-identity.md: who may
 * dispatch which agent, and who may grant an agent its reach. **Both** are
 * required — dispatch control alone is decorative, because anyone who can grant
 * an agent production credentials does not need permission to dispatch it.
 *
 * The grants themselves are no longer here. They were static configuration
 * (`CONTROL_PAIR_GRANTS`) while the Organization plane could not answer, which
 * was the interim the decision blessed *provided the config took the shape of
 * the eventual claim*. It did, so moving to `principal_grants` and issuing the
 * claim was a data move — see `services/grants.ts`, which now owns the
 * authority, and `auth/jwt-claims.ts`, which puts it in the token.
 *
 * What is left here is the part that is neither storage nor policy: whether the
 * control runs at all, and what a refusal *is*.
 */

/**
 * Is the control pair enforced in this deployment?
 *
 * An explicit switch rather than "are there any grants", because those two
 * differ in exactly the dangerous case: a deployment that MEANT to enforce and
 * whose grants failed to load would silently enforce nothing. Inferring
 * enforcement from data makes an empty table indistinguishable from a disabled
 * control.
 *
 * The literal lowercase `"true"`, matching `ENABLE_KAAMBAAN_BRIDGE` — this
 * codebase already learned that a looser boolean lets `=1` pass validation and
 * start nothing.
 */
export function isControlPairEnforced(): boolean {
  return process.env.ENFORCE_CONTROL_PAIR === "true";
}

/**
 * A dispatch refused by the control pair.
 *
 * A distinct type because a denial is **permanent** and every other failure at
 * that point is transient. Callers that retry — the kaambaan bridge hands a
 * claim back and lets the board reissue it — must be able to tell the
 * difference, or a refusal becomes a hot loop: claim, refuse, release, claim
 * again, forever.
 */
export class ControlPairDenied extends Error {
  readonly principalId: string;
  readonly stationKey: string;

  constructor(principalId: string, stationKey: string) {
    super("You do not have permission to dispatch this agent.");
    this.name = "ControlPairDenied";
    this.principalId = principalId;
    this.stationKey = stationKey;
  }
}

/** Is this the control pair refusing, rather than something transient? */
export function isControlPairDenied(e: unknown): e is ControlPairDenied {
  return e instanceof ControlPairDenied || (e as { name?: string })?.name === "ControlPairDenied";
}

/**
 * An act refused by the second half of the pair.
 *
 * A separate type rather than a subclass of `ControlPairDenied`, deliberately:
 * the kaambaan bridge treats a `ControlPairDenied` as a **permanent** dispatch
 * refusal and stops retrying that card. A refusal to *write into* an agent must
 * never be mistaken for one, or a workspace-permission problem would be
 * diagnosed — and given up on — as a dispatch grant problem.
 */
export class GrantReachDenied extends Error {
  readonly principalId: string;
  /** The station key, or "fleet" for acts that name no station. */
  readonly target: string;
  readonly capability: string | null;

  constructor(principalId: string, target: string, capability: string | null) {
    super("You do not have permission to change this agent.");
    this.name = "GrantReachDenied";
    this.principalId = principalId;
    this.target = target;
    this.capability = capability;
  }
}

/** Is this the reach half refusing, rather than something transient? */
export function isGrantReachDenied(e: unknown): e is GrantReachDenied {
  return e instanceof GrantReachDenied || (e as { name?: string })?.name === "GrantReachDenied";
}
