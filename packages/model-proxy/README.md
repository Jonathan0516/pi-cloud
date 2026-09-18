# @earendil-works/pi-model-proxy (private, experimental)

The brain never holds a vendor key. Workers get a short-lived HMAC token bound to one tenant and one session and present it wherever the provider adapter would have sent the key. The proxy verifies the token, swaps in the real key from its own environment, forwards to the vendor it has mapped for that provider, streams the response back, and records one `billing_events` row per call.

```text
worker ── Authorization: Bearer <token> ──▶  /v1/<provider>/<path>  ──▶  vendor (real key injected)
             x-pi-session: <session>            token check, tenant rate limit,
                                                model allowlist, usage metering
```

- **Upstreams** come from pi-ai's built-in catalog (`@earendil-works/pi-ai/providers/all`); `PI_MODEL_PROXY_UPSTREAMS` overrides or adds `{ "provider": { "baseUrl", "api" } }`. The worker cannot choose where a provider's traffic goes.
- **Keys** come from `<PROVIDER>_API_KEY` variables, `PI_MODEL_PROXY_KEYS` (JSON), or `PI_MODEL_PROXY_KEYS_FILE` (a pi `auth.json`). A provider without a key is refused with 502 before any upstream call.
- **Tokens**: `mintProxyToken(secret, { tenant, session }, ttlSeconds)`; the minting process (the cloud server) holds `PI_MODEL_PROXY_SECRET`, workers do not. Requests whose `x-pi-session` does not match the token are refused.
- **Policy**: `PI_MODEL_PROXY_ALLOW_MODELS` is a comma-separated list of `provider/model` globs; `PI_MODEL_PROXY_RATE_LIMIT` is requests per tenant per minute (default 300).
- **Billing**: with `PI_PG_URL` set, every call lands in `billing_events` (tenant, session, operation, provider, model, status, bytes, duration, and token counts parsed from Anthropic Messages or OpenAI chat/responses bodies, JSON or SSE). This is separate from the session usage ledger, which the harness owns.

Worker side: `createProxyCredentials(token, providers)` builds the credential store and `withModelProxy(models, proxyUrl)` rewrites every model's `baseUrl` to the proxy route. `packages/cloud-worker` wires both when `PI_MODEL_PROXY_URL` is configured.

```bash
PI_MODEL_PROXY_SECRET=... PI_MODEL_PROXY_KEYS_FILE=~/.pi/agent/auth.json PI_PG_URL=... \
  tsx --tsconfig tsconfig.json packages/model-proxy/src/main.ts
```

Bedrock (SigV4) and OAuth-only providers are not proxied. OpenAI-compatible adapters auto-detect compatibility from the base URL, so behind the proxy they treat every upstream as generic OpenAI-compatible.
