# @soa-harness/example-provider-adapter

**Reference scaffold** for adopters wiring a real LLM provider behind the `@soa-harness/runner` §16.3 dispatcher.

> This package is NOT intended for production. It's a copy-and-customize starting point. Fork it, rename, swap the request shape to match your provider, and remove this notice.

## Why this exists

The v1.1 dispatcher ships with one adapter: `InMemoryTestAdapter`, used for conformance probing. Real LLM providers (OpenAI, Anthropic, Bedrock, Azure, local llama.cpp server) are adopter-written. This package demonstrates the pattern.

## What it demonstrates

- Implementing `ProviderAdapter` with a sync-mode `dispatch()` method
- Shaping a `DispatchRequest` into a provider-specific HTTP POST body (defaults to the OpenAI-compatible Chat Completions shape — works unmodified against OpenAI, Azure OpenAI, Anthropic's OpenAI-compat endpoint, groq, together.ai, and any llama.cpp server with `--openai-compat`)
- Honoring `AbortSignal` so dispatcher-level cancellation interrupts the in-flight fetch cleanly
- Classifying HTTP status codes into the §16.3.1 taxonomy via `AdapterError`
- Parsing the provider response back into a `DispatchResponse` with the echo contract preserved

## What it deliberately does NOT do

- Real provider auth (API keys via env, OAuth flows, AWS SigV4) — adopters wire this
- **Streaming** — M8 scope once the dispatcher ships streaming mode
- Tool-schema translation — depends on the provider's tool-use wire shape
- Prompt caching, structured outputs, function-call mode, provider-specific beta features

## Usage

```typescript
import { Dispatcher, buildRunnerApp } from "@soa-harness/runner";
import { ExampleProviderAdapter } from "@soa-harness/example-provider-adapter";

const adapter = new ExampleProviderAdapter({
  baseUrl: "https://api.openai.com/v1",
  apiKey: process.env.OPENAI_API_KEY!,
  name: "openai",
});

const dispatcher = new Dispatcher({
  adapter,
  budgetTracker,  // your BudgetTracker
  auditChain,     // your AuditChain
  clock: () => new Date(),
});

const app = await buildRunnerApp({
  // ...other runner opts
  dispatch: {
    dispatcher,
    sessionStore,
    clock: () => new Date(),
  },
});
```

## Customization checklist

When adapting for your actual provider, edit:

1. **`buildChatRequestBody()`** — reshape the body to match your provider's wire format. Defaults to OpenAI-compatible.
2. **`classifyHttpError()`** — map your provider's status codes + error bodies to `DispatcherErrorCode`. The default handles 429/401/403/5xx/400; extend for provider-specific error codes.
3. **`buildDispatchResponse()`** — parse your provider's response shape. Defaults parse `choices[0].message.content`; extend for tool calls, refusals, multimodal content, etc.
4. **Auth headers** — `classifyHttpError()` assumes `Bearer <token>`. For AWS SigV4, Azure AD, or mutual TLS, replace the `Authorization` header construction with your provider's scheme.
5. **Streaming** — when the dispatcher ships streaming mode, add a `dispatchStream()` method. Until then, synchronous mode is sufficient for v1.1 conformance.

## Don't do your own retries

The dispatcher owns the retry budget (§16.3 step 5, §16.3.1 — `MAX_DISPATCHER_RETRIES=3` across retryable classes). The adapter's job is to THROW `AdapterError` on provider failures, not to retry. If you add adapter-level retry, you're stacking retries on top of dispatcher retries and will exceed the §16.3.1 bound.

## Testing

`FetchLike` is injectable:

```typescript
const adapter = new ExampleProviderAdapter({
  baseUrl: "http://fake",
  apiKey: "test",
  fetchFn: async (url, init) => {
    // Drive deterministic responses
    return new Response(JSON.stringify({ choices: [...], usage: {...} }));
  },
});
```

See `test/adapter.test.ts` for patterns including abort-signal propagation and error classification.

## License

Apache-2.0 — same as the rest of `@soa-harness/*`. Fork freely.

## References

- Core §16.3 — dispatcher request/response contract (the `ProviderAdapter` interface)
- Core §16.3.1 — provider error taxonomy
- `@soa-harness/runner` `DispatchRequest` / `DispatchResponse` / `AdapterError` types
- L-62 in the spec repo's `IMPLEMENTATION_LESSONS.md` — where this scaffold landed
