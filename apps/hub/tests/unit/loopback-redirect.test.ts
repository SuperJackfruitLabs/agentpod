/**
 * The loopback exception to exact redirect matching.
 *
 * `isRegisteredRedirect` is full-string equality on purpose — prefix or origin matching is how
 * an authorize endpoint becomes a credential-minting open redirector. A CLI cannot pin a port,
 * so it needs an exception, and an exception to that rule earns this much scrutiny.
 *
 * Most of these tests are attacks. The one worth reading twice is `localhost`.
 */
import { describe, expect, test } from "bun:test";
import {
  LOOPBACK_MARKER,
  isLoopbackRedirect,
  isRegisteredRedirect,
  parseOAuthClients,
  type OAuthClient,
} from "../../src/config";

const cli: OAuthClient = { id: "apn", redirectUris: [LOOPBACK_MARKER] };
const plane: OAuthClient = { id: "kaambaan", redirectUris: ["https://kaambaan.dev/hub/callback"] };

describe("what a native app may register back to", () => {
  test("any port on 127.0.0.1, which is the whole point", () => {
    for (const port of [1024, 8080, 49152, 65535]) {
      expect(isLoopbackRedirect(`http://127.0.0.1:${port}/callback`)).toBe(true);
    }
    expect(isLoopbackRedirect("http://127.0.0.1/callback")).toBe(true);
  });

  test("IPv6 loopback too", () => {
    expect(isLoopbackRedirect("http://[::1]:9000/callback")).toBe(true);
  });
});

describe("what it must refuse", () => {
  test("`localhost` — the clause people skip", () => {
    // `localhost` is a NAME. It resolves through DNS and /etc/hosts, so whoever can answer for
    // it receives the authorization code. An IP literal cannot be answered for.
    expect(isLoopbackRedirect("http://localhost:8080/callback")).toBe(false);
    expect(isLoopbackRedirect("http://LOCALHOST:8080/callback")).toBe(false);
  });

  test("a host that merely starts with the loopback address", () => {
    expect(isLoopbackRedirect("http://127.0.0.1.evil.com/callback")).toBe(false);
    expect(isLoopbackRedirect("http://127.0.0.1evil.com/callback")).toBe(false);
  });

  test("path traversal, which URL normalises before we ever compare", () => {
    // Arrives as `/evil`. The equality is what refuses it, not the normalisation.
    expect(isLoopbackRedirect("http://127.0.0.1:8080/callback/../evil")).toBe(false);
    expect(isLoopbackRedirect("http://127.0.0.1:8080/callbackevil")).toBe(false);
    expect(isLoopbackRedirect("http://127.0.0.1:8080/")).toBe(false);
  });

  test("userinfo, which makes a human misread the host", () => {
    expect(isLoopbackRedirect("http://evil.com@127.0.0.1/callback")).toBe(false);
    expect(isLoopbackRedirect("http://127.0.0.1@evil.com/callback")).toBe(false);
  });

  test("a query or a fragment", () => {
    expect(isLoopbackRedirect("http://127.0.0.1:8080/callback?next=https://evil.com")).toBe(false);
    expect(isLoopbackRedirect("http://127.0.0.1:8080/callback#x")).toBe(false);
  });

  test("any scheme but http", () => {
    for (const uri of [
      "https://127.0.0.1:8080/callback",
      "file:///callback",
      "javascript:alert(1)//127.0.0.1/callback",
      "data:text/html,127.0.0.1/callback",
    ]) {
      expect(isLoopbackRedirect(uri), uri).toBe(false);
    }
  });

  test("a non-loopback address", () => {
    expect(isLoopbackRedirect("http://10.0.0.5/callback")).toBe(false);
    expect(isLoopbackRedirect("http://0.0.0.0/callback")).toBe(false);
    expect(isLoopbackRedirect("http://169.254.169.254/callback")).toBe(false); // cloud metadata
  });

  test("nonsense", () => {
    for (const uri of ["", "not a url", "127.0.0.1/callback"]) {
      expect(isLoopbackRedirect(uri), uri).toBe(false);
    }
  });
});

describe("the marker is opt-in, per client", () => {
  test("a client without it gets no loopback at all", () => {
    // kaambaan is a web plane. If it ever asked to redirect to a machine-local port, that is a
    // compromise, not a feature.
    expect(isRegisteredRedirect(plane, "http://127.0.0.1:8080/callback")).toBe(false);
  });

  test("a client with it still gets its exact URIs honoured", () => {
    const both: OAuthClient = { id: "x", redirectUris: [LOOPBACK_MARKER, "https://x.dev/cb"] };
    expect(isRegisteredRedirect(both, "https://x.dev/cb")).toBe(true);
    expect(isRegisteredRedirect(both, "http://127.0.0.1:1/callback")).toBe(true);
    expect(isRegisteredRedirect(both, "https://x.dev/other")).toBe(false);
  });

  test("the marker itself is never a usable redirect destination", () => {
    // A client registering `loopback` must not thereby be able to redirect to the string.
    expect(isLoopbackRedirect(LOOPBACK_MARKER)).toBe(false);
  });

  test("and it parses from the registry env the ordinary way", () => {
    const [apn] = parseOAuthClients("apn|loopback");
    expect(apn!.id).toBe("apn");
    expect(isRegisteredRedirect(apn!, "http://127.0.0.1:5555/callback")).toBe(true);
    expect(isRegisteredRedirect(apn!, "http://localhost:5555/callback")).toBe(false);
  });
});
