# Changelog

## 0.2.0 - 2026-11-25

- `guardedStream(label, { idleMs, totalMs }, body, onChunk?)`: reads a streamed body under a per-chunk idle timer (restarted on every chunk) and a total deadline. Rejects with `GuardedCallTimeoutError`, new phase `"idle"` for a stalled chunk and `"body"` for the total deadline. Like the other guards it rejects without waiting for `reader.cancel()` to do anything.
- `GuardedCallTimeoutError.phase` is now `"call" | "body" | "idle"`.

## 0.1.0 - 2026-11-18

- `guardedCall`, `guardedFetchText` and `guardedBindingRun`: a wall-clock deadline that rejects with `GuardedCallTimeoutError` even if the runtime ignores `abort()`.
- `guardedFetchText` puts the fetch and the full body read under one deadline.
- Observed on the Cloudflare Workers runtime; no upstream documentation was found either way.
