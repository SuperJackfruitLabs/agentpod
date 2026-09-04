import { describe, expect, test } from "bun:test";
import {
  redactUrlSecrets,
  SECRET_QUERY_PARAMS,
} from "../../src/utils/redact-url-secrets";

describe("redactUrlSecrets", () => {
  test("redacts the appservice token that was found in journald", () => {
    // The exact shape observed on infra on 2026-09-04, one line per Matrix event.
    const line =
      "<-- PUT /_matrix/app/v1/transactions/u7zYJALs?access_token=fbb82681a1ec62113cff4737";
    const out = redactUrlSecrets(line);
    expect(out).toBe("<-- PUT /_matrix/app/v1/transactions/u7zYJALs?access_token=***");
    expect(out).not.toContain("fbb82681");
  });

  test("redacts every name in the list, so adding one to the list is the whole change", () => {
    for (const name of SECRET_QUERY_PARAMS) {
      const out = redactUrlSecrets(`GET /x?${name}=super-secret-value`);
      expect(out, `${name} must be redacted`).not.toContain("super-secret-value");
      expect(out).toContain(`${name}=***`);
    }
  });

  test("redacts a parameter that is not the first", () => {
    expect(redactUrlSecrets("GET /x?a=1&token=abc&b=2")).toBe("GET /x?a=1&token=***&b=2");
  });

  test("redacts more than one on a line", () => {
    expect(redactUrlSecrets("GET /x?token=a&code=b")).toBe("GET /x?token=***&code=***");
  });

  test("is case-insensitive on the name", () => {
    expect(redactUrlSecrets("GET /x?Access_Token=abc")).not.toContain("abc");
  });

  test("leaves ordinary parameters alone, so the log stays useful", () => {
    const line = "--> GET /api/nodes?limit=50&status=online 200 4ms";
    expect(redactUrlSecrets(line)).toBe(line);
  });

  test("does not redact a parameter that merely CONTAINS a secret name", () => {
    // `not_a_token` and `tokenCount` are not credentials; redacting them would
    // quietly hide ordinary debugging information.
    const line = "GET /x?not_a_token=visible&tokenCount=3";
    expect(redactUrlSecrets(line)).toBe(line);
  });

  test("passes through a line with no query string", () => {
    expect(redactUrlSecrets("<-- GET /health")).toBe("<-- GET /health");
  });
});
