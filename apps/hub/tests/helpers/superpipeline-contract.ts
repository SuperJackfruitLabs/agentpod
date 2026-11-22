/**
 * SuperPipeline's HTTP contracts, as treaty publishes them, for the hub's tests.
 *
 * The hub calls two of SuperPipeline's APIs: the agent work loop (`agent-work.v1`, an agent's own
 * token) and the decisions a person makes in chat (`decisions.v1`, a person's assertion). Both are
 * OpenAPI documents in `@superjackfruitlabs/treaty-contracts`, with valid and invalid cases for
 * every operation. A fake board wrapped with `contractFetch` (or `contractWebFetch`, for the
 * write-back helpers that take a `fetch`) refuses any request that reaches no operation of either
 * document, or whose body the operation's request schema refuses: the test fails at the call, with
 * the route and the schema's reasons, rather than passing against a board that does not exist.
 */
import { matchRoute, openApi, validateRequest, type Api } from "@superjackfruitlabs/treaty-contracts";
import { loadInstalledBundle } from "@superjackfruitlabs/treaty-contracts/node";
import { readFileSync } from "node:fs";

import type { Fetcher } from "../../src/services/bridge/superpipeline";
import { noteContractViolation } from "./superpipeline-contract-violations";

export const bundle = loadInstalledBundle();

export const AGENT_WORK = "schemas/http/superpipeline/agent-work.v1.openapi.json";
export const DECISIONS = "schemas/http/superpipeline/decisions.v1.openapi.json";

export const agentWork: Api = openApi(bundle, AGENT_WORK);
export const decisions: Api = openApi(bundle, DECISIONS);

/** The operation a request reaches, in either document, or null. */
export function operationFor(method: string, url: string): { api: Api; operationId: string } | null {
  const path = new URL(url, "https://board.test").pathname;
  for (const api of [agentWork, decisions]) {
    const operationId = matchRoute(api, method, path);
    if (operationId) return { api, operationId };
  }
  return null;
}

/** Why the contracts refuse a request, or null when they describe it. */
export function contractRefusal(method: string, url: string, body: string | undefined): string | null {
  const found = operationFor(method, url);
  if (!found) return `${method} ${url} reaches no operation of agent-work.v1 or decisions.v1`;
  const parsed: unknown = body === undefined ? undefined : JSON.parse(body);
  const result = validateRequest(bundle, found.api, found.operationId, parsed);
  if (!result.valid) return `${method} ${url} (${found.operationId}) sent a body its contract refuses: ${result.errors.join("; ")}`;
  return null;
}

/**
 * A request the hub sent, refused unless the contract describes it: thrown at the call, and kept so
 * the test fails even if the code under test catches the throw (`tests/preload.ts`). Returns the
 * operation id.
 */
export function assertContractedRequest(method: string, url: string, body: string | undefined): string {
  const refusal = contractRefusal(method, url, body);
  if (refusal) {
    noteContractViolation(refusal);
    throw new Error(refusal);
  }
  const found = operationFor(method, url);
  if (!found) throw new Error("unreachable: a described request reaches an operation");
  return found.operationId;
}

/** A `Fetcher` whose every request is held to the contracts before `inner` answers it. */
export function contractFetch(inner: Fetcher, seen?: string[]): Fetcher {
  return async (url, init) => {
    const op = assertContractedRequest(init.method, url, init.body);
    seen?.push(op);
    return inner(url, init);
  };
}

/** The same, for code that takes a global-`fetch`-shaped dependency. */
export function contractWebFetch(inner: typeof fetch, seen?: string[]): typeof fetch {
  const wrapped = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const body = init?.body;
    if (body !== undefined && body !== null && typeof body !== "string") throw new Error("contractWebFetch: only string bodies are checked");
    const op = assertContractedRequest(init?.method ?? "GET", url, body ?? undefined);
    seen?.push(op);
    return inner(input, init);
  };
  return Object.assign(wrapped, { preconnect: fetch.preconnect });
}

export interface Cases {
  valid: Record<string, unknown>;
  invalid: Array<{ why: string; body: unknown }>;
}

interface OperationCases {
  request?: Cases;
  responses?: Record<string, Cases>;
}

const read = (path: string): unknown =>
  JSON.parse(readFileSync(Bun.resolveSync(`@superjackfruitlabs/treaty-contracts/data/${path}`, import.meta.dir), "utf8"));

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isCases(v: unknown): v is Cases {
  return isRecord(v) && isRecord(v.valid) && Array.isArray(v.invalid);
}

function isOperationCases(v: unknown): v is OperationCases {
  if (!isRecord(v)) return false;
  if (v.request !== undefined && !isCases(v.request)) return false;
  return v.responses === undefined || (isRecord(v.responses) && Object.values(v.responses).every(isCases));
}

const casesOf = (path: string): Record<string, OperationCases> => {
  const doc = read(path);
  if (!isRecord(doc) || !isRecord(doc.operations)) throw new Error(`${path} holds no operations`);
  const out: Record<string, OperationCases> = {};
  for (const [id, cases] of Object.entries(doc.operations)) {
    if (!isOperationCases(cases)) throw new Error(`${path}: ${id} is not a set of cases`);
    out[id] = cases;
  }
  return out;
};

const OPERATION_CASES: Record<string, OperationCases> = {
  ...casesOf("fixtures/http/superpipeline/agent-work.v1.cases.json"),
  ...casesOf("fixtures/http/superpipeline/decisions.v1.cases.json"),
};

/** The valid response bodies treaty keeps for an operation at a status. Throws when it keeps none. */
export function validResponses(operationId: string, status = "200"): Array<[string, unknown]> {
  const cases = OPERATION_CASES[operationId]?.responses?.[status];
  if (!cases || Object.keys(cases.valid).length === 0) throw new Error(`no valid ${status} cases for ${operationId}`);
  return Object.entries(cases.valid);
}

/** The request cases treaty keeps for an operation. Throws when it keeps none. */
export function requestCases(operationId: string): Cases {
  const cases = OPERATION_CASES[operationId]?.request;
  if (!cases) throw new Error(`no request cases for ${operationId}`);
  return cases;
}

/** `error.v1`'s own cases: the envelope every SuperPipeline refusal travels in. */
export const errorEnvelopeCases: Cases = (() => {
  const cases = read("fixtures/common/error.v1.cases.json");
  if (!isCases(cases)) throw new Error("error.v1 holds no cases");
  return cases;
})();

interface RegisteredCode {
  code: string;
  owner: string;
  envelope: string;
  status: number;
}

function isRegisteredCode(v: unknown): v is RegisteredCode {
  return isRecord(v) && typeof v.code === "string" && typeof v.owner === "string" && typeof v.envelope === "string" && typeof v.status === "number";
}

const registeredCodes: RegisteredCode[] = (() => {
  const doc = read("contracts/error-codes.json");
  const codes = isRecord(doc) ? doc.codes : undefined;
  if (!Array.isArray(codes) || !codes.every(isRegisteredCode)) throw new Error("contracts/error-codes.json holds no codes");
  return codes;
})();

/** Every error code an operation lists, with the status the registry gives it. */
export function errorCodesOf(operationId: string): Array<{ code: string; status: number }> {
  const op = [...agentWork.operations, ...decisions.operations].find((o) => o.id === operationId);
  if (!op) throw new Error(`no operation ${operationId}`);
  return op.errorCodes.map((code) => {
    const found = registeredCodes.find((c) => c.code === code && c.owner === "superpipeline");
    if (!found) throw new Error(`${operationId} lists ${code}, which the registry does not hold`);
    return { code, status: found.status };
  });
}
