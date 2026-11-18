/**
 * A hard wall-clock deadline for any external call: HTTP fetches, runtime
 * bindings, SDK clients.
 *
 * MECHANISM CONTRACT (do not "simplify" this):
 *   The deadline is enforced by `Promise.race` against an independent
 *   `setTimeout`, not by `AbortSignal`. The `AbortController` is passed to the
 *   call as a best-effort courtesy so the runtime MAY free the socket. The
 *   guard's correctness must never depend on the signal being honored.
 *
 *   Why: in production, two separate pipeline steps each hung for about six
 *   hours behind a correct AbortController + setTimeout. The Workers runtime
 *   (workerd) was observed not to propagate the abort into a response-body
 *   read that was already open. This is an observation from production, not
 *   documented behaviour; a search for upstream documentation found nothing.
 *   Since there is no documented guarantee to lean on, the deadline lives in
 *   one shared module instead of a per-call-site convention.
 *
 * On timeout, `controller.abort()` is called as fire-and-forget cleanup and
 * the promise rejects with `GuardedCallTimeoutError` right after. The reject
 * never waits for the abort to take effect.
 *
 * A finished call always clears its timer in a `finally` block, so a
 * successful call leaves no timer behind.
 */

/**
 * Thrown when a call exceeds its `timeoutMs` deadline. `phase` is `'call'` for
 * `guardedCall` and `guardedBindingRun`, and `'body'` for `guardedFetchText`,
 * where the deadline covers both the `fetch()` and the body read.
 */
export class GuardedCallTimeoutError extends Error {
  readonly code = "GUARDED_CALL_TIMEOUT" as const;
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
    readonly phase: "call" | "body",
  ) {
    super(`guardedCall[${label}] exceeded ${timeoutMs}ms in phase '${phase}'`);
    this.name = "GuardedCallTimeoutError";
  }
}

/**
 * Hard wall-clock deadline on any external call.
 *
 * `fn` receives an `AbortSignal` it MAY pass to `fetch()` or any other
 * abort-aware API. The signal is aborted when the timer fires, but the
 * rejection is driven by the independent timer racing `fn(signal)`. If `fn`
 * ignores the signal, `guardedCall` still rejects on time.
 */
export async function guardedCall<T>(
  label: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Courtesy only: never awaited, never on the reject path.
      controller.abort();
      reject(new GuardedCallTimeoutError(label, timeoutMs, "call"));
    }, timeoutMs);
  });
  try {
    return await Promise.race([fn(controller.signal), timeoutPromise]);
  } finally {
    // Narrowed rather than `clearTimeout(timer)` directly: Workers-runtime
    // ambient types type `clearTimeout` as `(id: number | null)` and reject
    // `undefined`. `timer` is always set by here.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * `fetch()` plus a full body-text read, both bounded by one shared deadline.
 * A stalled body read on an otherwise successful `fetch()` is the failure that
 * caused the two six-hour hangs, so the read is never trusted to bound itself
 * through `AbortSignal` propagation.
 */
export async function guardedFetchText(
  label: string,
  timeoutMs: number,
  url: string,
  init?: RequestInit,
): Promise<{ res: Response; text: string }> {
  try {
    return await guardedCall(label, timeoutMs, async (signal) => {
      const res = await fetch(url, { ...init, signal });
      const text = await res.text();
      return { res, text };
    });
  } catch (err) {
    if (err instanceof GuardedCallTimeoutError) {
      throw new GuardedCallTimeoutError(label, timeoutMs, "body");
    }
    throw err;
  }
}

/**
 * For runtime bindings (for example a Workers AI `env.AI.run(...)`) that take
 * no `AbortSignal` at all. Racing an independent timer is the only mechanism
 * available, so `run` receives no signal.
 */
export async function guardedBindingRun<T>(
  label: string,
  timeoutMs: number,
  run: () => Promise<T>,
): Promise<T> {
  return guardedCall(label, timeoutMs, () => run());
}
