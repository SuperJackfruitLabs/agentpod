/**
 * "A hub is running against this database" (security review finding 4).
 *
 * The hub takes a session-level advisory lock at boot, on a connection of its own, and holds it
 * until it exits. Operator scripts that must not run under a live hub
 * (`scripts/rewrite-user-ids.ts --apply`) ask for the same lock exclusively with
 * `pg_try_advisory_lock` and refuse when they cannot have it.
 *
 * The key is fixed and documented here and in docs/OPERATING.md: the two-int form
 * (classid 1095782212 = 0x41504F44, ASCII "APOD"; objid 1), which shows in `pg_locks` as
 * `locktype = 'advisory', classid = 1095782212, objid = 1, objsubid = 2`. The hub takes it SHARED,
 * so two hubs on one database (a rolling deploy) do not lock each other out; a script takes it
 * EXCLUSIVE, which no hub can share. A hub that finds the lock held exclusively refuses to boot
 * rather than run mid-maintenance.
 *
 * No imports from the hub: the scripts read `HUB_RUNNING_LOCK` without pulling in the hub's
 * connection module or config.
 */
import postgres from "postgres";

export const HUB_RUNNING_LOCK = { classid: 0x41504f44, objid: 1 } as const;

export interface HubRunningLock {
  release(): Promise<void>;
}

/** How often the holder checks it still has the lock (a dropped connection loses it). */
const REASSERT_MS = 30_000;

export async function holdHubRunningLock(url: string, log: (msg: string) => void = console.warn): Promise<HubRunningLock> {
  // One connection, never idled out: the lock lives exactly as long as this session.
  const sql = postgres(url, { max: 1, idle_timeout: 0, max_lifetime: null, onnotice: () => {} });
  const { classid, objid } = HUB_RUNNING_LOCK;
  const take = async (): Promise<boolean> => {
    // Take it only when this session does not already hold it, so re-asserting never stacks.
    const [r] = await sql<{ ok: boolean }[]>`
      SELECT CASE WHEN EXISTS (
        SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid()
          AND classid = ${classid} AND objid = ${objid} AND objsubid = 2 AND granted)
      THEN true ELSE pg_try_advisory_lock_shared(${classid}, ${objid}) END AS ok`;
    return r!.ok;
  };
  let ok: boolean;
  try {
    ok = await take();
  } catch (e) {
    await sql.end();
    throw e;
  }
  if (!ok) {
    await sql.end();
    throw new Error(
      "a maintenance script holds this database's hub-running lock (scripts/rewrite-user-ids.ts --apply?); " +
        "refusing to start until it finishes",
    );
  }
  const timer = setInterval(() => {
    take()
      .then((held) => {
        if (!held) log("hub-running lock: could not re-take it after a reconnect; a maintenance script holds it");
      })
      .catch((e) => log(`hub-running lock: re-assert failed: ${String(e)}`));
  }, REASSERT_MS);
  timer.unref?.();
  return {
    async release() {
      clearInterval(timer);
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * For scripts: try to take the lock exclusively on `sql` (which must be a single-connection
 * client, so the lock sits on the session the script then works in). False means a hub holds it.
 */
export async function tryExclusiveHubLock(sql: postgres.Sql): Promise<boolean> {
  const [r] = await sql<{ ok: boolean }[]>`SELECT pg_try_advisory_lock(${HUB_RUNNING_LOCK.classid}, ${HUB_RUNNING_LOCK.objid}) AS ok`;
  return r!.ok;
}

export async function releaseExclusiveHubLock(sql: postgres.Sql): Promise<void> {
  await sql`SELECT pg_advisory_unlock(${HUB_RUNNING_LOCK.classid}, ${HUB_RUNNING_LOCK.objid})`;
}

export const HUB_RUNNING_REFUSAL = "the hub is running against this database";
