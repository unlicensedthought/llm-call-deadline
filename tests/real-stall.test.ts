import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { GuardedCallTimeoutError, guardedCall, guardedFetchText } from "../src/guarded-call.js";

let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/stall") {
      // Headers and a partial body go out, then the connection goes quiet.
      res.writeHead(200, { "content-type": "text/plain" });
      res.write("partial");
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("fine");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

describe("against a real stalled HTTP body", () => {
  it("guardedFetchText rejects with phase 'body' when headers arrive and the body stalls", async () => {
    const started = Date.now();
    await expect(guardedFetchText("real-stall", 200, `${base}/stall`)).rejects.toMatchObject({
      name: "GuardedCallTimeoutError",
      phase: "body",
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("guardedFetchText returns the body when the server answers", async () => {
    const { text } = await guardedFetchText("real-ok", 2000, `${base}/ok`);
    expect(text).toBe("fine");
  });
});

describe("control: an abort-only deadline on a signal-deaf call", () => {
  it("never settles on its own, which is the failure the guard exists to prevent", async () => {
    vi.useFakeTimers();
    try {
      let settled = false;
      const controller = new AbortController();
      const deaf = new Promise<string>(() => {});
      deaf.then(
        () => (settled = true),
        () => (settled = true),
      );
      setTimeout(() => controller.abort(), 1000);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(controller.signal.aborted).toBe(true);
      expect(settled).toBe(false);

      const guarded = guardedCall("same-deaf-call", 1000, () => new Promise<string>(() => {}));
      const assertion = expect(guarded).rejects.toBeInstanceOf(GuardedCallTimeoutError);
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
