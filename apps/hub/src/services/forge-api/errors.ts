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
