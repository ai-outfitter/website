# Hosted inference gateway (disabled by default)

The Worker exposes authenticated `/v1/models`, `/v1/chat/completions`, and
`/api/cli/usage`. Enable `CLI_AUTH_ENABLED` and `INFERENCE_ENABLED` only after
configuring the models, provider secret, workspace allowance/spending policy,
and testing payment and usage reconciliation. No models ship enabled.

Set `OPENROUTER_API_KEY` as a Worker secret. Never put it in a catalog or client.
`INFERENCE_MODELS` is an operator-owned JSON variable, applied to production and
preview separately. Example **illustrative, not live pricing**:

```json
{
  "rate": { "version": "2026-09-example", "markupBps": 2000 },
  "accounts": { "org:123": { "version": "partner-example", "markupBps": 0 } },
  "models": [{
    "id": "vendor/model", "upstream": "vendor/model", "name": "Example",
    "provider": "provider-slug", "contextLength": 32768, "maxOutputTokens": 4096,
    "promptMicrosPerToken": 1, "completionMicrosPerToken": 2,
    "cacheReadMicrosPerToken": 0.1, "cacheWriteMicrosPerToken": 1.25,
    "requestMicros": 0
  }]
}
```

All price fields are required nonnegative USD microdollar ceilings. The operator
must verify the chosen provider's **entire context tier**, prompt, cache read,
cache write, completion/reasoning, and fixed request prices before enabling it.
Do not list models with additional billable modalities or cost modes. Change the
rate version whenever changing markup. Reservations snapshot the applied rate;
configuration updates do not reprice outstanding requests.

Requests pin the configured provider with fallback disabled and upstream prompt,
completion and request price ceilings. The initial API accepts text and function
tools only. It rejects caller routing, plugins, media, multiple generations,
cache-control hints and arbitrary additional options. Body size is at most
256 KiB; output tokens cannot exceed the model allowance. Conservative UTF-8
input sizing can reject inputs that a provider tokenizer could accept.

Before dispatch, a request reserves the whole configured context at the sum of
prompt/cache price ceilings, plus its bounded completion and fixed request
cost, including markup. This can reserve materially more than the final charge.
Account-level atomic admission prevents concurrent use of the same balance.

`InferenceRequest` stores request identity, account/user attribution, rate,
reservation maximum, generation ID, actual cost, and state. It never stores
prompts or credentials. Response usage is authoritative; missing cost is not
zero. The generation ID is persisted before its event is forwarded. Cancellation
or ambiguous upstream failure retains the reservation. A durable alarm queries
OpenRouter generation metadata after ten minutes, retrying every minute for an
hour and then daily. A failed settlement retries the same final charge.

Monitor `inference_reconciliation_required` events. A request without a generation
ID cannot be automatically reconciled: investigate provider billing before any
manual release. Costs exceeding the conservative reservation also require
operator reconciliation; the hold is retained. No expiry makes unresolved usage
free. Credential rotation must preserve access to outstanding generation records.

Only authoritative pre-generation HTTP rejection (400/401/402/403/404/422/429)
releases a reservation automatically. Error responses omit upstream bodies.

Validation: fragmented UTF-8/CRLF SSE, tool-call forwarding, disconnect retention,
lookup retries and missing cost, denied budgets, allowlist/cost-mode rejection,
workspace attribution, account markup, and disabled-route behavior are covered
by the inference tests. These are local tests; paid production and live provider
acceptance remain deployment gates.
