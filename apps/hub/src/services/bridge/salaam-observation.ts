/** Keep the original board/execution lease fresh only while awaiting an observation.
 * No overlapping renewals, no renewal survives return, and a lost lease always wins
 * over a late observation result. This never extends the configured lease duration. */
export async function observeWithLease<T>(
  observe: () => Promise<T>,
  renew: () => Promise<void>,
  intervalMs = 15_000,
): Promise<T> {
  let stopped = false,
    pending: Promise<void> | undefined,
    timer: ReturnType<typeof setTimeout> | undefined;
  let failed = false,
    failure: unknown;
  let rejectFailure!: (error: unknown) => void;
  const lost = new Promise<never>((_resolve, reject) => {
    rejectFailure = reject;
  });
  const schedule = () => {
    timer = setTimeout(() => {
      if (stopped) return;
      pending = renew()
        .catch((error) => {
          failed = true;
          failure = error;
          rejectFailure(error);
        })
        .finally(() => {
          pending = undefined;
          if (!stopped && !failed) schedule();
        });
    }, intervalMs);
  };
  schedule();
  try {
    const value = await Promise.race([Promise.resolve().then(observe), lost]);
    stopped = true;
    if (timer) clearTimeout(timer);
    await pending;
    if (failed) throw failure;
    return value;
  } finally {
    stopped = true;
    if (timer) clearTimeout(timer);
    await pending;
  }
}
