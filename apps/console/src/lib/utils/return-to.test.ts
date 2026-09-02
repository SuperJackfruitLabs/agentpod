import { test, expect } from "vitest";
import { resolveReturnTo, RETURN_PARAM } from "./return-to";

/**
 * The allowlist behind `/login`'s return path.
 *
 * A login page that forwards anywhere after authenticating is a phishing gadget: it takes a
 * password on a page the operator trusts and then hands them to a destination the link author
 * chose. So these cases are mostly about what is REFUSED, and every refusal is `/` rather than an
 * error — a bad return path is not worth a dead end.
 */

const APP = "https://console.agentpod.dev";
const HUB = "https://hub.agentpod.dev";

const AUTHORIZE =
  `${HUB}/api/auth/authorize?client=kaambaan&redirect_uri=https%3A%2F%2Fkaambaan.dev%2Fhub%2Fcallback` +
  "&state=abc&code_challenge=vX9v2t8QpM7wR3nK1sJ4dF6hL0zY5cB8aE2gN7uT1oQ&code_challenge_method=S256";

test("the parameter is the one the hub actually sets", () => {
  // Read from apps/hub/src/routes/auth-authorize.ts rather than assumed:
  // `signIn.searchParams.set("redirect", back.toString())`.
  expect(RETURN_PARAM).toBe("redirect");
});

test("no parameter goes home, exactly as before", () => {
  expect(resolveReturnTo(null, HUB, APP)).toBe("/");
  expect(resolveReturnTo(undefined, HUB, APP)).toBe("/");
  expect(resolveReturnTo("", HUB, APP)).toBe("/");
});

test("a hub-origin authorize URL is resumed, whole", () => {
  // The point of the change. Every parameter has to survive: the hub rebuilt this URL from values
  // it had already validated, and a state or challenge mangled on the way back is a flow that
  // fails at the callback instead of here.
  expect(resolveReturnTo(AUTHORIZE, HUB, APP)).toBe(AUTHORIZE);
});

test("an off-origin URL goes home, never to the attacker", () => {
  expect(resolveReturnTo("https://evil.example/steal", HUB, APP)).toBe("/");
  expect(resolveReturnTo("https://hub.agentpod.dev.evil.example/x", HUB, APP)).toBe("/");
  // Protocol-relative: resolves against our origin into a real one, which is then refused. Without
  // the resolve it would read as a path and be treated as same-origin.
  expect(resolveReturnTo("//evil.example/steal", HUB, APP)).toBe("/");
});

test("a same-origin path comes back as a path", () => {
  // `goto` wants a path, and returning one is also how the caller knows this destination does not
  // need a full browser navigation.
  expect(resolveReturnTo("/fleet?tab=nodes#x", HUB, APP)).toBe("/fleet?tab=nodes#x");
  expect(resolveReturnTo(`${APP}/fleet`, HUB, APP)).toBe("/fleet");
});

test("a scheme that is not http(s) goes home", () => {
  // These parse, and their origin is "null" — refused by scheme so the reason is the real one.
  expect(resolveReturnTo("javascript:alert(document.cookie)", HUB, APP)).toBe("/");
  expect(resolveReturnTo("data:text/html,<script>1</script>", HUB, APP)).toBe("/");
});

test("garbage goes home rather than throwing", () => {
  expect(resolveReturnTo("http://[", HUB, APP)).toBe("/");
});

test("with no hub connected, only this origin is allowed", () => {
  // Fail closed: a console that does not know which hub it is talking to cannot vouch for one.
  expect(resolveReturnTo(AUTHORIZE, null, APP)).toBe("/");
  expect(resolveReturnTo("/fleet", null, APP)).toBe("/fleet");
});

test("it is the connected hub that is allowed, not any hub", () => {
  // A console pointed at somebody's own hub must resume that hub's authorize and no other.
  expect(resolveReturnTo(AUTHORIZE, "https://hub.someone-else.dev", APP)).toBe("/");
  expect(resolveReturnTo(AUTHORIZE, `${HUB}/`, APP)).toBe(AUTHORIZE);
});
