/** A reactive stand-in for `auth` (the store's getters are reactive): a test flips it mid-render. */
export const mockAuth = $state({
  isInitialized: true,
  isAuthenticated: true,
  isWorkspaceAdmin: true,
  isHubOperator: false,
});
