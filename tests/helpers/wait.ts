/**
 * Deterministic waits for tests (#628): poll the observable a test actually needs instead of
 * sleeping a fixed amount and hoping the frame/ack is still there when the loop wakes up.
 */

/**
 * Bounded poll: the deadline is the only failure bound, so a slow runner stretches the wait
 * instead of failing an assertion whose observable simply had not arrived yet.
 */
export async function waitFor(
  check: () => boolean,
  label = "condition",
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/**
 * Parks a fake turn until the test releases it (#628). A turn built on `setTimeout` keeps the
 * "thinking" and "queue: n" frames on screen for a few dozen milliseconds; on a loaded runner
 * the poll can miss that window and then wait forever for a frame that will never come back.
 */
export class TurnGate {
  readonly #waiting: (() => void)[] = [];

  /** Turns currently parked, i.e. in flight from the UI's point of view. */
  get parked(): number {
    return this.#waiting.length;
  }

  /** Parks the caller; resolves on `release()`. */
  enter(): Promise<void> {
    return new Promise((resolve) => this.#waiting.push(resolve));
  }

  /** Lets the oldest parked turn finish; returns false when nothing was parked. */
  release(): boolean {
    const next = this.#waiting.shift();
    if (next === undefined) return false;
    next();
    return true;
  }
}
