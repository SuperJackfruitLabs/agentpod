/**
 * Workspace authority, as the console says it.
 *
 * The hub answers to the caller's role in their workspace: owners and admins change the fleet,
 * members use it. A hub-wide setting belongs to the hub operator. Every place a member meets a
 * control they may not use says so in the same plain words, from here.
 */

/** The hub's refusal when a member calls a workspace-admin route. */
export const WORKSPACE_ADMIN_REQUIRED = "workspace_admin_required";

/** Who to ask, appended to every "admins can …" line. */
export const ASK_AN_ADMIN = "Ask an owner or admin of your workspace.";

/** "Workspace admins can enrol nodes. Ask an owner or admin of your workspace." */
export function workspaceAdminsCan(what: string): string {
  return `Workspace admins can ${what}. ${ASK_AN_ADMIN}`;
}

/** The sentence an API refusal with `workspace_admin_required` becomes. */
export const WORKSPACE_ADMIN_REQUIRED_MESSAGE = `Only workspace admins can do that. ${ASK_AN_ADMIN}`;

/** Who to ask about a hub-wide setting. */
export const ASK_THE_OPERATOR = "Ask whoever runs this hub.";
