/**
 * SuperLibrary's answers, held to treaty's `superlibrary.api` contract
 * (`schemas/http/superlibrary/api.v1.openapi.json`, treaty 0.0.19).
 *
 * Every call the hub makes through `SuperlibraryCaller` (uploads, a file's bytes, commit,
 * verification, related work, roster invalidation) has its answer checked with treaty-contracts'
 * `validateResponse` before the caller reads it. An answer the contract refuses is reported, as
 * SuperLibrary drifting from what it promised, and then handed on unchanged: the callers keep
 * reading it exactly as they did, so a drift is a warning in the log, never a new failure. A
 * route the contract does not hold (search, a library item's content) is not checked.
 */
import { matchRoute, openApi, validateResponse, type Api, type Bundle } from "@superjackfruitlabs/treaty-contracts";
import { loadInstalledBundle } from "@superjackfruitlabs/treaty-contracts/node";

export const SUPERLIBRARY_API = "schemas/http/superlibrary/api.v1.openapi.json";

/** One answer the contract refuses. */
export interface ContractRefusal {
  operationId: string;
  status: number;
  errors: string[];
}

/** The path a route is matched on: the request's, without its query. */
const routeOf = (path: string): string => path.split("?", 1)[0] ?? path;

let loaded: { bundle: Bundle; api: Api } | null | undefined;
function contract(): { bundle: Bundle; api: Api } | null {
  if (loaded === undefined) {
    try {
      const bundle = loadInstalledBundle();
      loaded = { bundle, api: openApi(bundle, SUPERLIBRARY_API) };
    } catch {
      loaded = null; // no contract to hold answers to: check nothing
    }
  }
  return loaded;
}

/**
 * The contract's word on one answer: null when it describes it or does not hold the route, the
 * refusal otherwise. `path` may carry a query string.
 */
export function superlibraryRefusal(method: string, path: string, status: number, body: unknown): ContractRefusal | null {
  const c = contract();
  if (!c) return null;
  const operationId = matchRoute(c.api, method, routeOf(path));
  if (!operationId) return null;
  const result = validateResponse(c.bundle, c.api, operationId, status, body);
  return result.valid ? null : { operationId, status, errors: result.errors };
}

/**
 * Checks an answer without consuming it, and reports a refusal through `onRefusal`. Never throws:
 * a body that is not JSON is itself a refusal, and the response goes back to its caller as it came.
 */
export async function checkSuperlibraryAnswer(
  method: string,
  path: string,
  res: Response,
  onRefusal: (r: ContractRefusal) => void,
): Promise<void> {
  try {
    const c = contract();
    const operationId = c ? matchRoute(c.api, method, routeOf(path)) : undefined;
    if (!operationId) return;
    const text = await res.clone().text();
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      onRefusal({ operationId, status: res.status, errors: ["the body is not JSON"] });
      return;
    }
    const refusal = superlibraryRefusal(method, path, res.status, body);
    if (refusal) onRefusal(refusal);
  } catch {
    // a check that cannot run (a body cut off mid-read) changes nothing for the caller
  }
}
