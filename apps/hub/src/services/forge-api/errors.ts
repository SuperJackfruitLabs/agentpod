export type ForgeApiConfigErrorCode = "preset-none-needs-no-token" | "mode-not-minted";

/**
 * A grant whose configuration cannot do what was asked. A client mistake, so routes map it to 4xx
 * via `status` rather than 500. Messages never carry a token or response body.
 */
export class ForgeApiConfigError extends Error {
  readonly status = 422;
  constructor(
    readonly code: ForgeApiConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ForgeApiConfigError";
  }
}

export type ForgeApiGrantErrorCode =
  | "station-not-found"
  | "grant-not-found"
  | "no-occupant"
  | "capability-missing"
  | "station-key-unavailable"
  | "bad-repository"
  | "mode-not-supported"
  | "grant-exists"
  | "grant-not-deliverable"
  | "mint-failed"
  | "revoke-failed"
  | "seal-failed"
  | "delivery-failed"
  | "bad-transition"
  | "state-conflict"
  | "handle-persist-failed"
  | "grant-busy"
  | "grant-not-verifiable"
  | "grant-not-rotatable"
  | "rotation-failed"
  | "expected-login-required"
  | "bad-expected-login"
  | "bad-sealed-blob"
  | "bad-policy";

const GRANT_ERROR_STATUS: Record<ForgeApiGrantErrorCode, number> = {
  "station-not-found": 404,
  "grant-not-found": 404,
  "no-occupant": 409,
  "capability-missing": 409,
  // The node is the upstream that failed to answer with a key: a gateway error, like the observe routes.
  "station-key-unavailable": 502,
  "bad-repository": 422,
  "mode-not-supported": 422,
  "grant-exists": 409,
  "grant-not-deliverable": 409,
  "mint-failed": 502,
  "revoke-failed": 502,
  "seal-failed": 500,
  "delivery-failed": 502,
  "bad-transition": 500,
  "state-conflict": 409,
  "handle-persist-failed": 500,
  "grant-busy": 409,
  "grant-not-verifiable": 409,
  "grant-not-rotatable": 409,
  "rotation-failed": 502,
  "expected-login-required": 422,
  "bad-expected-login": 422,
  "bad-sealed-blob": 422,
  "bad-policy": 422,
};

/**
 * A grant lifecycle step that could not proceed. `status` is the HTTP mapping for routes. Messages
 * are built by the hub from ids and fixed text only: never a token, a sealed blob or a body.
 */
export class ForgeApiGrantError extends Error {
  readonly status: number;
  constructor(
    readonly code: ForgeApiGrantErrorCode,
    message: string,
    readonly grantId?: string,
  ) {
    super(message);
    this.name = "ForgeApiGrantError";
    this.status = GRANT_ERROR_STATUS[code];
  }
}
