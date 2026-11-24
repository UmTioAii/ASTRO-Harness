/** Snapshot/restore of `process.env` for test files that mutate globals (#656). */

/**
 * Captures the current value of `keys` and returns an idempotent `restore`.
 * A key that was absent is deleted on restore (never turned into an empty
 * string), so a leak caused by a timeout does not survive the file's `afterAll`.
 */
export function snapshotEnv(keys: readonly string[]): () => void {
  const saved = keys.map((key) => [key, process.env[key]] as const);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

interface StoppableServer {
  stop(force?: boolean): void;
}

interface ServeSurface {
  serve: (options: unknown) => StoppableServer;
}

export interface ServerTracker {
  /** Servers started while the tracker was installed, in start order. */
  readonly started: readonly StoppableServer[];
  /** Stops whatever is still running and restores the original `Bun.serve`. */
  restore(): void;
}

/**
 * Wraps `Bun.serve` so the caller can close listeners a test left behind (#656).
 * A test that hits its timeout skips its own `finally`, but the file's
 * `afterAll` still runs and stops the residue.
 */
export function trackBunServe(): ServerTracker {
  const bun = Bun as unknown as ServeSurface;
  const base = bun.serve;
  const started: StoppableServer[] = [];
  bun.serve = (options) => {
    const server = base(options);
    started.push(server);
    return server;
  };
  return {
    started,
    restore() {
      bun.serve = base;
      for (const server of started.reverse()) {
        try { server.stop(true); } catch { /* already stopped */ }
      }
    },
  };
}
