# llm-call-deadline

A wall-clock deadline for LLM and `fetch` calls that does not trust `AbortSignal`.

## The problem

The usual timeout for a model call is an `AbortController` plus a `setTimeout`
that calls `abort()`. That works when the runtime honors the abort. In
production, two pipeline steps each hung for about six hours behind exactly
that code. The response headers had arrived. The body read was already open.
The abort never reached it. I observed this on the Cloudflare Workers runtime;
I found no upstream documentation of it either way.

## Quick start

```ts
import { guardedCall, guardedFetchText, guardedBindingRun } from "./src/guarded-call.js";

// Any async call. The signal is passed in as a courtesy.
const out = await guardedCall("summarize", 30_000, (signal) =>
  client.complete(prompt, { signal }),
);

// fetch + full body read under ONE deadline.
const { res, text } = await guardedFetchText("chat", 30_000, url, {
  method: "POST",
  body: JSON.stringify(payload),
});

// A binding that takes no signal at all.
const r = await guardedBindingRun("embed", 10_000, () => env.AI.run(model, input));
```

On timeout each one rejects with `GuardedCallTimeoutError`
(`label`, `timeoutMs`, `phase`: `"call"` or `"body"`).

## How it works

`guardedCall` races `fn(signal)` against its own `setTimeout`. When the timer
fires it calls `controller.abort()` without awaiting it, then rejects. The
rejection does not depend on the abort doing anything. The timer is cleared in
a `finally`, so a call that finishes leaves nothing behind.

## Limits

- It bounds how long the caller waits. It does not stop the work. If the runtime
  ignores the abort, the socket and the pending read may stay open until the
  runtime reaps them.
- The deadline is one number per call. It has no retry, backoff or budget logic.
  Wrap it in your own retry loop.
- It does not cancel a call that has already produced side effects.
- Streaming responses are not handled. The deadline covers the whole read.
- The runtime behavior behind the original hangs is an observation, not a
  documented guarantee.

## Tests

```
./scripts/verify.sh     # install, build, typecheck, test; last line is a VERIFY verdict
npm test                # tests only
```

Tests use fake timers for the hostile cases (a promise that never settles and
never looks at the signal) and a local HTTP server that sends headers and a
partial body, then goes quiet.

## License

Apache-2.0.
