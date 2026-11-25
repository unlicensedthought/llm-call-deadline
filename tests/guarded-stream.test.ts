import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { GuardedCallTimeoutError, guardedStream } from "../src/guarded-call.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** A stream that emits `count` chunks, one every `everyMs`, then closes. */
function ticking(count: number, everyMs: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((r) => setTimeout(r, everyMs));
      if (i >= count) return controller.close();
      controller.enqueue(enc.encode(`c${i++};`));
    },
  });
}

/** Emits `first` chunks immediately, then never produces anything again. */
function stallsAfter(first: number): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < first) {
        controller.enqueue(enc.encode(`c${i++};`));
        return;
      }
      return new Promise<void>(() => {});
    },
  });
}

/** Hostile reader: read() never settles and cancel() is ignored (never settles). */
function ignoresCancel(): { body: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let cancelled = false;
  const reader = {
    read: () => new Promise<never>(() => {}),
    cancel: () => {
      cancelled = true;
      return new Promise<void>(() => {});
    },
  };
  const body = { getReader: () => reader } as unknown as ReadableStream<Uint8Array>;
  return { body, cancelled: () => cancelled };
}

describe("guardedStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("succeeds when chunks keep arriving past idleMs in total but under totalMs", async () => {
    // 10 chunks, 400ms apart: 4000ms total, well past idleMs, under totalMs.
    const seen: string[] = [];
    const p = guardedStream("steady", { idleMs: 500, totalMs: 10_000 }, ticking(10, 400), (c) =>
      seen.push(dec.decode(c)),
    );
    await vi.advanceTimersByTimeAsync(4400);
    const out = await p;
    expect(dec.decode(out)).toBe("c0;c1;c2;c3;c4;c5;c6;c7;c8;c9;");
    expect(seen).toHaveLength(10);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects with phase 'idle' about idleMs after the stream stalls between chunks", async () => {
    const p = guardedStream("stall", { idleMs: 500, totalMs: 60_000 }, stallsAfter(2));
    const assertion = expect(p).rejects.toMatchObject({
      name: "GuardedCallTimeoutError",
      label: "stall",
      phase: "idle",
      timeoutMs: 500,
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still rejects on time when the reader ignores cancel", async () => {
    const { body, cancelled } = ignoresCancel();
    const p = guardedStream("deaf", { idleMs: 300, totalMs: 60_000 }, body);
    const assertion = expect(p).rejects.toBeInstanceOf(GuardedCallTimeoutError);
    await vi.advanceTimersByTimeAsync(300);
    await assertion;
    expect(cancelled()).toBe(true);
  });

  it("totalMs bounds a stream that trickles forever", async () => {
    const p = guardedStream("trickle", { idleMs: 500, totalMs: 2000 }, ticking(Number.MAX_SAFE_INTEGER, 300));
    const assertion = expect(p).rejects.toMatchObject({ phase: "body", timeoutMs: 2000 });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    // The guard's own timers are gone. The source's in-flight pull timer may
    // still be pending; once it fires the cancelled stream schedules no more.
    await vi.advanceTimersByTimeAsync(1000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a cancel that resolves the pending read as done does not turn a timeout into success", async () => {
    // A real ReadableStream resolves a pending read with done:true on cancel.
    const p = guardedStream("cut", { idleMs: 200, totalMs: 60_000 }, stallsAfter(1));
    const assertion = expect(p).rejects.toMatchObject({ phase: "idle" });
    await vi.advanceTimersByTimeAsync(200);
    await assertion;
  });

  it("propagates an onChunk error and clears its timers", async () => {
    const p = guardedStream("boom", { idleMs: 500, totalMs: 10_000 }, stallsAfter(3), () => {
      throw new Error("consumer failed");
    });
    await expect(p).rejects.toThrow("consumer failed");
    expect(vi.getTimerCount()).toBe(0);
  });
});
