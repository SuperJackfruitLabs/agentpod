import { describe, expect, test } from "bun:test";
import { SpanStatusCode } from "@opentelemetry/api";
import { Hono } from "hono";
import { useTestTelemetry } from "../../tests/helpers/telemetry";
import { httpServerSpans, idAttributesFor } from "./http-middleware";

const t = useTestTelemetry();

const evidence = new Hono()
  .get("/runs/:source/:externalRunId", (c) => c.json({}))
  .get("/attempts/:attemptId", (c) => c.json({}));
const app = new Hono()
  .use("*", httpServerSpans())
  .use("/api/*", async (_c, next) => next())
  .get("/api/stations/:id", (c) => c.text("ok"))
  .get("/boom", () => {
    throw new Error("CANARY-CONTENT-7f3a");
  })
  .route("/api/evidence", evidence)
  .get("/health", (c) => c.text("ok"));

const only = () => {
  const spans = t.spans();
  expect(spans).toHaveLength(1);
  return spans[0]!;
};

describe("HTTP server spans", () => {
  test("are named by route template, never by raw path or query", async () => {
    await app.request("/api/stations/st_123?access_token=sekrit-token");
    const s = only();
    expect(s.name).toBe("GET /api/stations/:id");
    expect(s.attributes["http.route"]).toBe("/api/stations/:id");
    expect(s.attributes["http.response.status_code"]).toBe(200);
    const dump = JSON.stringify([s.name, s.attributes, s.events]);
    expect(dump).not.toContain("sekrit-token");
    expect(dump).not.toContain("st_123");
  });

  test("an unmatched path is named by its method alone", async () => {
    await app.request("/no/such/st_999");
    const s = only();
    expect(s.name).toBe("GET");
    expect(s.attributes["http.response.status_code"]).toBe(404);
    expect(JSON.stringify(s.attributes)).not.toContain("st_999");
  });

  test("an ALL route with a concrete path (like /mcp) names the span; a wildcard does not", async () => {
    const a = new Hono()
      .use("*", httpServerSpans())
      .all("/mcp", (c) => c.text("ok"))
      .all("/proxy/*", (c) => c.text("ok"));
    await a.request("/mcp", { method: "POST" });
    const s = only();
    expect(s.name).toBe("POST /mcp");
    expect(s.attributes["http.route"]).toBe("/mcp");
  });

  test("continue an incoming traceparent", async () => {
    await app.request("/api/stations/x", {
      headers: { traceparent: "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01" },
    });
    const s = only();
    expect(s.spanContext().traceId).toBe("0af7651916cd43dd8448eb211c80319c");
    expect(s.parentSpanContext?.spanId).toBe("b7ad6b7169203331");
  });

  test("a route about a run or an attempt carries its id (C1)", async () => {
    await app.request("/api/evidence/runs/superpipeline/run_abc");
    expect(only().attributes["run.id"]).toBe("run_abc");
    expect(t.spans()[0]!.name).toBe("GET /api/evidence/runs/:source/:externalRunId");
  });

  test("a thrown handler marks the span 500 without its message", async () => {
    const res = await app.request("/boom");
    expect(res.status).toBe(500);
    const s = only();
    expect(s.status.code).toBe(SpanStatusCode.ERROR);
    expect(s.attributes["error.type"]).toBe("500");
    expect(JSON.stringify([s.attributes, s.events, s.status])).not.toContain("CANARY-CONTENT-7f3a");
  });

  test("a malformed percent-escape in an id segment leaves the response alone and ends one span", async () => {
    const res = await app.request("/api/evidence/runs/x/%E0%A4%A");
    expect(res.status).toBe(200);
    const s = only();
    expect(s.attributes["http.response.status_code"]).toBe(200);
    expect(s.attributes["run.id"]).toBe("%E0%A4%A");
  });

  test("health checks are not traced", async () => {
    await app.request("/health");
    expect(t.spans()).toHaveLength(0);
  });
});

describe("idAttributesFor", () => {
  test("maps run and attempt params, ignores the rest", () => {
    expect(idAttributesFor("/api/evidence/runs/:source/:externalRunId", "/api/evidence/runs/superpipeline/run_1")).toEqual({
      "run.id": "run_1",
    });
    expect(idAttributesFor("/api/evidence/attempts/:attemptId", "/api/evidence/attempts/attempt_9")).toEqual({
      "attempt.id": "attempt_9",
    });
    expect(idAttributesFor("/api/stations/:id", "/api/stations/s")).toEqual({});
    expect(() => idAttributesFor("/runs/:runId", "/runs/%E0%A4%A")).not.toThrow();
  });
});
