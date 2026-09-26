import { describe, expect, test } from "bun:test";
import { exportPKCS8, exportSPKI, generateKeyPair, importSPKI, jwtVerify } from "jose";

import { appJwt, installationToken, APP_JWT_TTL_S } from "./github-app";

/**
 * Minting an agent's git credential.
 *
 * The App private key is the credential that mints every other credential here, so what is
 * asserted is what a holder of the public key would see — the JWT is verified, not read back.
 */

let onceKeys: Promise<{ pem: string; spki: string }> | null = null;
function keys() {
  onceKeys ??= (async () => {
    const pair = await generateKeyPair("RS256", { extractable: true });
    return { pem: await exportPKCS8(pair.privateKey), spki: await exportSPKI(pair.publicKey) };
  })();
  return onceKeys;
}

describe("appJwt", () => {
  test("verifies against the app's public key, and expires within GitHub's ten-minute ceiling", async () => {
    const { pem, spki } = await keys();
    const token = await appJwt("123456", pem);

    const { payload } = await jwtVerify(token, await importSPKI(spki, "RS256"), {
      issuer: "123456",
      algorithms: ["RS256"],
    });

    const life = (payload.exp as number) - (payload.iat as number);
    expect(life).toBe(APP_JWT_TTL_S);
    // GitHub refuses an app JWT whose expiry is more than ten minutes out, and clocks drift, so
    // the ceiling is not the target.
    expect(life).toBeLessThanOrEqual(10 * 60);

    // Issued in the past on purpose: a clock a few seconds ahead of GitHub's makes an exactly-now
    // `iat` a token from the future, which is refused with an error that names neither clock.
    expect(payload.iat as number).toBeLessThan(Math.floor(Date.now() / 1000));
  });
});

describe("installationToken", () => {
  const ok = {
    token: "ghs_exampletoken",
    expires_at: "2026-09-27T01:00:00Z",
  };

  test("asks the installation endpoint, presenting the app JWT as a bearer", async () => {
    const { pem } = await keys();
    let seen: { url: string; auth: string | null; accept: string | null } | null = null;

    const token = await installationToken(
      { appId: "123456", privateKeyPem: pem, installationId: "42" },
      async (url, init) => {
        const h = new Headers(init?.headers);
        seen = { url: String(url), auth: h.get("authorization"), accept: h.get("accept") };
        return new Response(JSON.stringify(ok), { status: 201 });
      },
    );

    expect(token.token).toBe("ghs_exampletoken");
    expect(seen!.url).toBe("https://api.github.com/app/installations/42/access_tokens");
    expect(seen!.auth?.startsWith("Bearer ")).toBe(true);
    expect(seen!.accept).toBe("application/vnd.github+json");
  });

  test("a refusal names the status and carries no token", async () => {
    const { pem } = await keys();
    await expect(
      installationToken(
        { appId: "1", privateKeyPem: pem, installationId: "42" },
        async () => new Response("{}", { status: 403 }),
      ),
    ).rejects.toThrow(/403/);
  });

  test("a 2xx that carries no token is a failure, not an empty credential", async () => {
    // The shape that would otherwise hand `undefined` to a credential helper and fail later, at
    // `git push`, with an error about authentication rather than about this.
    const { pem } = await keys();
    await expect(
      installationToken(
        { appId: "1", privateKeyPem: pem, installationId: "42" },
        async () => new Response(JSON.stringify({ expires_at: ok.expires_at }), { status: 201 }),
      ),
    ).rejects.toThrow(/token/i);
  });
});
