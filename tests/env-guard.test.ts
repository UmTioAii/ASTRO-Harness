/**
 * Regression for #656: a test that hits its timeout never reaches its own
 * `finally`, so a file that mutates `process.env` must restore the snapshot in
 * `afterAll`. This test locks the hook the eval harness uses for that.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { snapshotEnv, trackBunServe } from "./helpers/env-guard";
import { TEST_ASTRO_HOME } from "./setup";

const EVAL_HOME = join(tmpdir(), "astro-eval-deadbeef", ".astro", "eval-home");

describe("snapshotEnv as an afterAll hook", () => {
  const restoreEnv = snapshotEnv([
    "ASTRO_HOME",
    "ASTRO_NO_GLOBAL_CONFIG",
    "ASTRO_ENV_GUARD_SENTINEL",
  ]);

  test("a case that leaves the env dirty does not reach the next test", () => {
    process.env.ASTRO_HOME = EVAL_HOME;
    process.env.ASTRO_NO_GLOBAL_CONFIG = "1";
    process.env.ASTRO_ENV_GUARD_SENTINEL = "leaked";
  });

  afterAll(restoreEnv);
});

test("afterAll restores ASTRO_HOME and deletes keys that did not exist", () => {
  expect(process.env.ASTRO_HOME).toBe(TEST_ASTRO_HOME);
  expect(process.env.ASTRO_NO_GLOBAL_CONFIG).toBeUndefined();
  expect(process.env.ASTRO_ENV_GUARD_SENTINEL).toBeUndefined();
});

// #656: a timed-out scenario skips its own `finally`, so the file-level hook
// must also close loopback listeners that were left running.
test("trackBunServe closes a loopback server the file leaves running", async () => {
  const tracker = trackBunServe();
  try {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("ok") });
    expect(tracker.started).toHaveLength(1);
    tracker.restore();
    const url = `http://127.0.0.1:${server.port}/`;
    await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
  } finally {
    tracker.restore();
  }
});
