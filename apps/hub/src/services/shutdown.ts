/** Dependencies the hub must release before its process can safely exit. */
export interface ShutdownDeps {
  stopSweeper: () => void;
  stopBridge?: () => Promise<void>;
  closeMatrixBridge?: () => Promise<void>;
  log?: (message: string, error?: unknown) => void;
  exit?: (code: number) => void;
}

/**
 * Create a signal handler that drains the hub once, even when systemd sends
 * SIGTERM and SIGINT close together. Matrix's native crypto machines must be
 * explicitly closed before Bun tears down napi's Tokio runtime.
 */
export function createGracefulShutdown(deps: ShutdownDeps) {
  let stopping: Promise<void> | null = null;
  const log = deps.log ?? ((message: string, error?: unknown) => console.log(message, error ?? ""));
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  return (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return stopping;

    stopping = (async () => {
      log(`Shutting down (${signal})...`);
      let failed = false;
      const release = async (name: string, action: (() => void | Promise<void>) | undefined) => {
        if (!action) return;
        try {
          await action();
        } catch (error) {
          failed = true;
          log(`Shutdown cleanup failed for ${name}:`, error);
        }
      };

      // Stop producers before closing the consumer that owns native crypto.
      await release("node sweeper", deps.stopSweeper);
      await release("superpipeline bridge", deps.stopBridge);
      await release("Matrix bridge", deps.closeMatrixBridge);
      exit(failed ? 1 : 0);
    })();

    return stopping;
  };
}
