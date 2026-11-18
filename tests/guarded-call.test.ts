/**
 * Tests for the shared deadline guard.
 *
 * The critical case is a hostile mock that never settles and never observes
 * the AbortSignal. It reproduces the body-read behaviour seen in production.
 * A guard that relies on `controller.abort()` stopping this promise hangs
 * forever here. `Promise.race` against an independent timer must still reject
 * within `timeoutMs`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  GuardedCallTimeoutError,
  guardedBindingRun,
  guardedCall,
  guardedFetchText,
} from "../src/guarded-call.js";

/** A promise that never resolves, never rejects, and (critically) never
 * observes anything passed to it -- the hostile case. */
const neverSettles = () => new Promise<never>(() => {});

describe("guardedCall", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects with GuardedCallTimeoutError at exactly timeoutMs, even when fn never settles and ignores the abort signal", async () => {
    // `fn` deliberately drops the signal argument entirely -- it never calls
    // `signal.addEventListener` or checks `signal.aborted`. If guardedCall's
    // correctness depended on the signal being honored, this would hang the
    // test runner forever under fake timers (vi.advanceTimersByTime does not
    // help a promise racing against nothing).
    const promise = guardedCall("hostile", 1000, (_signal) => neverSettles());

    const assertion = expect(promise).rejects.toThrow(GuardedCallTimeoutError);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
  });

  it("carries label, timeoutMs, and phase 'call' on the thrown error", async () => {
    const promise = guardedCall("my-label", 250, () => neverSettles());
    const assertion = (async () => {
      try {
        await promise;
        throw new Error("expected guardedCall to reject");
      } catch (err) {
        expect(err).toBeInstanceOf(GuardedCallTimeoutError);
        const gcte = err as GuardedCallTimeoutError;
        expect(gcte.label).toBe("my-label");
        expect(gcte.timeoutMs).toBe(250);
        expect(gcte.phase).toBe("call");
      }
    })();
    await vi.advanceTimersByTimeAsync(250);
    await assertion;
  });

  it("calls controller.abort() as a courtesy on timeout", async () => {
    let sawAbort = false;
    const promise = guardedCall("courtesy-abort", 100, (signal) => {
      signal.addEventListener("abort", () => {
        sawAbort = true;
      });
      return neverSettles();
    });
    const assertion = expect(promise).rejects.toThrow(GuardedCallTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertion;
    expect(sawAbort).toBe(true);
  });

  it("on the success path, clears its internal timer -- no leaked timer handle", async () => {
    const baseline = vi.getTimerCount();
    const result = await guardedCall("success", 5000, async () => "ok");
    expect(result).toBe("ok");
    // The timer that would have fired the timeout must be cleared once fn
    // resolves first -- no dangling handle left behind holding the isolate
    // open.
    expect(vi.getTimerCount()).toBe(baseline);
  });

  it("propagates fn's own rejection verbatim when fn rejects before the timeout", async () => {
    const boom = new Error("boom");
    await expect(
      guardedCall("fast-fail", 5000, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
  });
});

describe("guardedFetchText", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("rejects within timeoutMs when fetch() resolves but res.text() never settles and ignores abort", async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      text: () =>
        new Promise<string>(() => {
          // Never resolves, never rejects, ignores any abort signal.
        }),
    } as unknown as Response;
    const fakeFetch = vi.fn(() => Promise.resolve(fakeResponse));
    vi.stubGlobal("fetch", fakeFetch);

    const promise = guardedFetchText(
      "hostile-fetch",
      500,
      "https://example.invalid/x",
    );
    const assertion = (async () => {
      try {
        await promise;
        throw new Error("expected guardedFetchText to reject");
      } catch (err) {
        expect(err).toBeInstanceOf(GuardedCallTimeoutError);
        expect((err as GuardedCallTimeoutError).phase).toBe("body");
      }
    })();
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  it("returns { res, text } when both fetch and the body read settle before the ceiling", async () => {
    const fakeResponse = {
      ok: true,
      status: 200,
      text: () => Promise.resolve("hello world"),
    } as unknown as Response;
    const fakeFetch = vi.fn(() => Promise.resolve(fakeResponse));
    vi.stubGlobal("fetch", fakeFetch);

    const { res, text } = await guardedFetchText(
      "happy-fetch",
      5000,
      "https://example.invalid/x",
    );
    expect(text).toBe("hello world");
    expect(res).toBe(fakeResponse);
  });
});

describe("guardedBindingRun", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects within timeoutMs when a Workers-AI binding's run() never settles (bindings ignore AbortSignal entirely)", async () => {
    // No signal is even passed to `run` -- bindings have no abort surface at
    // all, so the mock here is stricter than guardedCall's own hostile case:
    // it takes zero arguments, same as a real `env.AI.run` closure would if
    // wrapped this way.
    const run = () => neverSettles();

    const promise = guardedBindingRun("binding-call", 750, run);
    const assertion = expect(promise).rejects.toThrow(GuardedCallTimeoutError);
    await vi.advanceTimersByTimeAsync(750);
    await assertion;
  });

  it("resolves with the binding's result when it settles before the ceiling", async () => {
    const run = () => Promise.resolve({ label: "POSITIVE", score: 0.9 });
    const result = await guardedBindingRun("binding-call-ok", 5000, run);
    expect(result).toEqual({ label: "POSITIVE", score: 0.9 });
  });
});
