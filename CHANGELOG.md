# Changelog

## 0.1.0 - 2026-11-18

- `guardedCall`, `guardedFetchText` and `guardedBindingRun`: a wall-clock deadline that rejects with `GuardedCallTimeoutError` even if the runtime ignores `abort()`.
- `guardedFetchText` puts the fetch and the full body read under one deadline.
- Observed on the Cloudflare Workers runtime; no upstream documentation was found either way.
