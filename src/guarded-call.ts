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
 * Thrown when a call exceeds its deadline. `phase` is `'call'` for
 * `guardedCall` and `guardedBindingRun`, and `'body'` for `guardedFetchText`,
 * where the deadline covers both the `fetch()` and the body read. For
 * `guardedStream`, `'idle'` means one chunk read went `idleMs` without
 * producing data (`timeoutMs` is then `idleMs`), and `'body'` means the whole
 * read passed `totalMs` (`timeoutMs` is then `totalMs`).
 */
export class GuardedCallTimeoutError extends Error {
  readonly code = "GUARDED_CALL_TIMEOUT" as const;
  constructor(
    readonly label: string,
    readonly timeoutMs: number,
    readonly phase: "call" | "body" | "idle",
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

/** Deadlines for `guardedStream`, both in milliseconds. */
export interface StreamDeadlines {
  /** Longest allowed wait for any single chunk. Restarted after every chunk. */
  idleMs: number;
  /** Longest allowed wall-clock time for the whole read. */
  totalMs: number;
}

/**
 * Cancel the reader as fire-and-forget cleanup. It is never awaited and never
 * on the reject path. A failing cancel is reported, not swallowed.
 */
function cancelReader(label: string, reader: ReadableStreamDefaultReader<Uint8Array>): void {
  const report = (err: unknown) => console.warn(`guardedStream[${label}] reader.cancel() failed`, err);
  try {
    reader.cancel().catch(report);
  } catch (err) {
    report(err);
  }
}

/**
 * Read a streamed body to the end under two independent wall-clock deadlines:
 * each chunk read is raced against its own `idleMs` timer (restarted on every
 * chunk), and the whole read is raced against `totalMs`. Rejects with
 * `GuardedCallTimeoutError` whose `phase` is `'idle'` or `'body'`.
 *
 * Like the other guards, rejection never depends on the stream cooperating:
 * on timeout the reject comes first and `reader.cancel()` is called without
 * being awaited, so a reader that ignores cancel still cannot hold the caller.
 *
 * `onChunk` is called synchronously for each chunk, so no caller code runs
 * between reads that the deadlines do not cover. Returns every chunk
 * concatenated.
 */
export async function guardedStream(
  label: string,
  { idleMs, totalMs }: StreamDeadlines,
  body: ReadableStream<Uint8Array>,
  onChunk?: (chunk: Uint8Array) => void,
): Promise<Uint8Array> {
  const reader = body.getReader();
  let totalTimer: ReturnType<typeof setTimeout> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutAfter = (ms: number, phase: "idle" | "body") =>
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        // Reject first: cancelling can resolve a pending read as `done`,
        // and that must not win the race and pass off a cut-short read.
        reject(new GuardedCallTimeoutError(label, ms, phase));
        cancelReader(label, reader);
      }, ms);
      if (phase === "body") totalTimer = timer;
      else idleTimer = timer;
    });
  const total = timeoutAfter(totalMs, "body");
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const idle = timeoutAfter(idleMs, "idle");
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), idle, total]);
      } finally {
        if (idleTimer !== undefined) clearTimeout(idleTimer);
      }
      if (result.done) break;
      chunks.push(result.value);
      length += result.value.byteLength;
      onChunk?.(result.value);
    }
  } catch (err) {
    // `onChunk` or the stream itself threw: stop reading. After a timeout the
    // cancel has already been issued.
    if (!(err instanceof GuardedCallTimeoutError)) cancelReader(label, reader);
    throw err;
  } finally {
    if (totalTimer !== undefined) clearTimeout(totalTimer);
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}
