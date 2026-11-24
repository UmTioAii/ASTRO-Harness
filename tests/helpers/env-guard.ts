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
