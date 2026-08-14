/**
 * How the boot banner names the database, without naming the password.
 *
 * The banner used to print `config.database.path` — the pre-pivot SQLite
 * default that nothing connects to (#321's other half). Printing DATABASE_URL
 * instead makes it true, but the URL carries credentials and boot output ends
 * up in journald, CI logs and screenshots. So: enough to identify the database,
 * never the secret.
 */
export function describeDatabase(url: string | undefined): string {
  if (!url) return "(DATABASE_URL not set)";

  try {
    const parsed = new URL(url);
    const user = parsed.username ? `${parsed.username}@` : "";
    const db = parsed.pathname.replace(/^\//, "");
    return `${user}${parsed.host}${db ? `/${db}` : ""}`;
  } catch {
    // Unparseable — which is exactly when someone has pasted the wrong thing,
    // possibly a secret. Say nothing about its contents, and do not throw: a
    // banner must never be the reason a boot dies.
    return "(DATABASE_URL unparseable)";
  }
}
