import type { ForgeProvider } from "./providers";

/**
 * GitHub: no hub-side mint or revoke. An App installation token is exchanged by stk, and a
 * supplied token is the operator's. Permissions come from the App installation or the PAT.
 */
export const githubProvider: ForgeProvider = {
  kind: "github",
  modes: ["app", "supplied"],
  expectedIdentity(grant) {
    const declared = grant.expectedLogin;
    if (!declared) throw new Error("forge: a github grant needs its declared login or app slug.");
    if (grant.mode === "app") {
      if (declared.endsWith("[bot]")) {
        throw new Error("forge: declare the App slug without the [bot] suffix.");
      }
      return `${declared}[bot]`;
    }
    return declared;
  },
  scopesFor() {
    return [];
  },
};
