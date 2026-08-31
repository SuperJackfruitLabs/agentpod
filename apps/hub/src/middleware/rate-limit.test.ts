/**
 * Which bucket a path falls in.
 *
 * `getLimitType` is the whole of the rate limiter's policy: everything else
 * counts. The bucket a path lands in is a security decision — `auth` is 60/min
 * because a credential-guessing surface should not get the 600/min an
 * ordinary read gets — and it was made by a `startsWith("/api/auth")` prefix
 * that no test held.
 *
 * The station-token exchange is the case that made this worth pinning. It
 * takes a secret (`<nodeId>:<nodeSecret>`), it sits OUTSIDE the auth
 * middleware chain by design (a node holds no session), and it is mounted
 * under `/api/nodes/...` — so the prefix put it in the generic bucket, giving
 * a guesser ten times the attempts the sign-in route allows.
 */

import { describe, expect, test } from "bun:test";

import { getLimitType } from "./rate-limit";

describe("rate-limit buckets", () => {
  test("the station-token exchange is auth traffic, not ordinary api traffic", () => {
    // Real shape: concrete ids, not the `:param` pattern — `c.req.path` is the
    // requested path.
    expect(
      getLimitType("/api/nodes/node_01H8XABCD/stations/stn_01H8XWXYZ/token")
    ).toBe("auth");
  });

  test("still buckets sign-in and ordinary reads as before", () => {
    expect(getLimitType("/api/auth/sign-in/email")).toBe("auth");
    expect(getLimitType("/api/stations")).toBe("api");
    expect(getLimitType("/api/nodes")).toBe("api");
    // A node route that is not the token exchange stays ordinary — the
    // stricter bucket is for the one that takes a secret, not for every path
    // with `nodes` in it.
    expect(getLimitType("/api/nodes/node_01H8XABCD/stations")).toBe("api");
    expect(getLimitType("/api/missions/m_1/events")).toBe("sse");
  });
});
