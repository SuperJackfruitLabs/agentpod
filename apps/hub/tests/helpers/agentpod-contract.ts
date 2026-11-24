/**
 * AgentPod's own HTTP contracts, as treaty publishes them, for the hub's route tests.
 *
 * Treaty phase 3 contracts three of the hub's read surfaces as OpenAPI documents in
 * `@superjackfruitlabs/treaty-contracts`: the capability catalog and bridge roster
 * (`capability-catalog.v1`), the fleet list (`fleet.v1`) and the evidence reads (`evidence.v1`).
 * A route app wrapped with `contractChecked` holds every response it answers to the document: the
 * request must reach one of its operations, and the status and body must be ones the operation
 * describes. A response the contract refuses throws at the call, with the operation and the
 * schema's reasons, so the test that made it fails where it asked.
 */
import { matchRoute, openApi, validateResponse, type Api } from "@superjackfruitlabs/treaty-contracts";
import { loadInstalledBundle } from "@superjackfruitlabs/treaty-contracts/node";

export const bundle = loadInstalledBundle();

export const CAPABILITY_CATALOG = "schemas/http/agentpod/capability-catalog.v1.openapi.json";
export const FLEET = "schemas/http/agentpod/fleet.v1.openapi.json";
export const EVIDENCE = "schemas/http/agentpod/evidence.v1.openapi.json";

export type AgentpodDocument = typeof CAPABILITY_CATALOG | typeof FLEET | typeof EVIDENCE;

const apis = new Map<string, Api>();
export function apiOf(doc: AgentpodDocument): Api {
  let api = apis.get(doc);
  if (!api) apis.set(doc, (api = openApi(bundle, doc)));
  return api;
}

/** Anything with Hono's `request`. */
interface Requestable {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
}

/** A route app whose every answer is held to its document. */
export interface CheckedApp {
  request: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface ContractCheckOptions {
  /**
   * Requests the document leaves out on purpose (the agent-only export `POST` is not in
   * `evidence.v1`). Answered unchecked; anything else that reaches no operation throws.
   */
  outside?: (method: string, path: string) => boolean;
  /** Each checked answer, as `operationId status`, for a test that every operation was reached. */
  seen?: Set<string>;
}

/** The document's word on one answer: the reasons it refuses it, empty when it describes it. */
export async function contractErrors(
  doc: AgentpodDocument,
  method: string,
  path: string,
  res: Response,
): Promise<{ operationId: string | undefined; errors: string[] }> {
  const api = apiOf(doc);
  const operationId = matchRoute(api, method, path);
  if (!operationId) return { operationId, errors: [`${method} ${path} reaches no operation of ${doc}`] };
  const text = await res.clone().text();
  let body: unknown;
  try {
    body = text === "" ? undefined : JSON.parse(text);
  } catch {
    return { operationId, errors: [`${operationId} answered ${res.status} with a body that is not JSON: ${text.slice(0, 120)}`] };
  }
  const result = validateResponse(bundle, api, operationId, res.status, body);
  return { operationId, errors: result.errors.map((e) => `${operationId} ${res.status}: ${e}`) };
}

/** The app's `request`, with every answer held to `doc` before the test sees it. */
export function contractChecked(app: Requestable, doc: AgentpodDocument, opts: ContractCheckOptions = {}): CheckedApp {
  const request = async (input: string, init?: RequestInit): Promise<Response> => {
    const res = await app.request(input, init);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(input, "http://hub.test").pathname;
    if (opts.outside?.(method, path)) return res;
    const { operationId, errors } = await contractErrors(doc, method, path, res);
    if (errors.length) throw new Error(`the hub answered outside ${doc}:\n${errors.join("\n")}`);
    opts.seen?.add(`${operationId} ${res.status}`);
    return res;
  };
  return { request };
}

/** Every `operationId status` pair the document describes, for a coverage check. */
export function describedAnswers(doc: AgentpodDocument): string[] {
  return apiOf(doc).operations.flatMap((op) => Object.keys(op.responses).map((s) => `${op.id} ${s}`));
}
