/**
 * Minting a GitHub credential for a station, from the App private key.
 *
 * Two steps, both GitHub's: sign a short App JWT with the App's private key, then exchange it for
 * an **installation access token** — which is what a `git push` actually uses. The installation
 * token lives one hour and is scoped to whatever the installation was granted, so the blast radius
 * of one leaking is bounded in both time and reach. Nothing long-lived ever reaches a station.
 *
 * `charter → docs/superpowers/specs/2026-09-27-agent-git-identity-design.md`.
 *
 * The App private key is the credential that mints every other credential here. It is never
 * logged, never returned, and never written anywhere a station can read.
 */
import { SignJWT, importPKCS8 } from "jose";

import { createLogger } from "../utils/logger";

const log = createLogger("github-app");

const GITHUB_API = "https://api.github.com";

/**
 * Nine minutes.
 *
 * GitHub refuses an App JWT expiring more than ten minutes out, and it compares against ITS clock.
 * Asking for the ceiling means any drift in our favour is a refusal whose message names neither
 * clock, so the ceiling is not the target.
 */
export const APP_JWT_TTL_S = 9 * 60;

/** Thirty seconds back, for the same reason in the other direction: a clock a little ahead of
 * GitHub's makes an exactly-now `iat` a token issued in the future. */
const IAT_BACKDATE_S = 30;

export interface GithubAppConfig {
  appId: string;
  /** PKCS#8 PEM. Held encrypted at rest; decrypted only to sign. */
  privateKeyPem: string;
  installationId: string;
}

export interface InstallationToken {
  token: string;
  expiresAt: string;
}

/** A fetch, injected so the exchange is testable without a network or a real App. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** The App's own assertion. Authenticates as the App, not as an installation — it cannot touch a
 * repository, only ask for the token that can. */
export async function appJwt(appId: string, privateKeyPem: string): Promise<string> {
  const key = await importPKCS8(privateKeyPem, "RS256");
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(appId)
    .setIssuedAt(now - IAT_BACKDATE_S)
    .setExpirationTime(now - IAT_BACKDATE_S + APP_JWT_TTL_S)
    .sign(key);
}

/**
 * Exchange the App JWT for an installation access token.
 *
 * Throws on anything that is not a token. A 2xx carrying no `token` is a failure here rather than
 * an empty credential handed onward, because the alternative surfaces three layers later as a
 * `git push` authentication error that names nothing useful.
 */
export async function installationToken(
  config: GithubAppConfig,
  fetchImpl: FetchLike = fetch,
): Promise<InstallationToken> {
  const jwt = await appJwt(config.appId, config.privateKeyPem);
  const url = `${GITHUB_API}/app/installations/${encodeURIComponent(config.installationId)}/access_tokens`;

  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "agentpod-hub",
    },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    // The status and nothing else: a body from this endpoint can echo request detail, and this one
    // was signed with the App key.
    log.warn("installation token refused", { status: res.status, installation: config.installationId });
    throw new Error(`github: the installation token exchange was refused (HTTP ${res.status}).`);
  }

  let body: { token?: unknown; expires_at?: unknown };
  try {
    body = (await res.json()) as typeof body;
  } catch {
    throw new Error("github: the installation token response was not JSON.");
  }
  if (typeof body.token !== "string" || body.token.trim() === "") {
    throw new Error("github: the installation token response carried no token.");
  }

  // Deliberately not the token. `station-matrix-credential.ts` records the device id and not the
  // credential for the same reason.
  log.info("installation token minted", {
    installation: config.installationId,
    expiresAt: typeof body.expires_at === "string" ? body.expires_at : null,
  });

  return {
    token: body.token,
    expiresAt: typeof body.expires_at === "string" ? body.expires_at : "",
  };
}
