# @earendil-works/pi-cloud-gateway (private, experimental)

The front door of the cloud service: API-key tenancy, a REST session catalog, and a WebSocket relay that speaks the same newline-JSON RPC the nodes in `packages/cloud-worker` speak. The gateway is stateless; every fact it needs is in PostgreSQL (the session tables, the lease table as routing table, and its own two tables).

```text
browser / CLI ──HTTPS REST──▶ gateway ──▶ PostgreSQL (catalog, keys, leases)
              ──WebSocket──▶ gateway ──TCP──▶ node holding the lease ──stdio──▶ worker
```

## Routes

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | liveness, unauthenticated |
| `GET` | `/v1/me` | tenant and user of the key |
| `GET` | `/v1/sessions` | the tenant's sessions, newest first, with `state` (`running`/`idle`) and `owner` (node) |
| `POST` | `/v1/sessions` | create; body `{ "title"?: string }`. Writes the session row and catalog entry only; the first attach starts a worker |
| `GET` | `/v1/sessions/:id` | one session |
| `DELETE` | `/v1/sessions/:id` | delete entries, values, lease, and catalog row. `409` while a worker holds the session. The workspace directory is left for the operator |
| `GET` | `/v1/bundles` | the tenant's resource bundles, newest first |
| `POST` | `/v1/bundles` | publish; body `{ "files": { "<path>": "<content>" }, "encoding"?: "utf8" \| "base64", "setDefault"?: true }`. The same bytes always yield the same version, so republishing returns `200` with `created: false` |
| `GET` | `/v1/bundles/:version` | one bundle's manifest |
| `GET`/`PUT`/`DELETE` | `/v1/tenant/bundle` | the version new sessions are pinned to; `PUT` body `{ "version": "<sha256>" }` |
| `GET` | `/v1/ws` | WebSocket upgrade with subprotocol `pi-cloud.v1` |

Every route except `/healthz` requires `Authorization: Bearer <key>`. A browser cannot set that header on a WebSocket, so the key may instead ride as a second subprotocol, `bearer.<key>`; the gateway answers with `pi-cloud.v1` alone. TLS terminates in front of this process.

## The WebSocket

One JSON frame per text message, the frames of `packages/coding-agent/src/experimental/mini/shared/rpc.ts`. A client attaches exactly as the local TUI does: `sessions.attach(null | id, cwd, presentationId)`, then `lane.watch` / `lane.prompt` and so on. The gateway answers `sessions` itself, scoped to the key's tenant (`attach(null)` creates a session in that tenant, `attach(id)` checks the catalog first), and forwards every other call to the node. Node events flow back untouched.

Which node: the live lease holder when one exists, otherwise the first reachable entry of `PI_GATEWAY_NODES`. That node takes the lease or, if it lost the race, relays onward itself. `webSocketTransport(url, key)` in `src/ws.ts` is a mini `Transport` that dials the gateway, so `connect()` and `listSessions()` from `mini/tui/session.ts` work unchanged against it. The web client can reuse it as is.

## Bundles

A resource bundle carries the skills, prompt templates, and prompt files a tenant's sessions run with; the format and the pinning rules are in `packages/cloud-worker`. The gateway owns publishing and the tenant default: a session created here records its tenant and is pinned to that default at creation, and every bundle route is scoped to the caller's tenant, so one tenant can neither read nor adopt another's bundle.

```bash
# from the repository root, with the gateway's environment set
tsx --tsconfig tsconfig.json packages/cloud-gateway/src/main.ts bundles publish ./my-bundle --tenant acme --set-default
tsx --tsconfig tsconfig.json packages/cloud-gateway/src/main.ts bundles list --tenant acme
tsx --tsconfig tsconfig.json packages/cloud-gateway/src/main.ts bundles set-default <version> --tenant acme
```

## Keys and tenants

Keys are random (`pik_` + 32 bytes base64url). The database stores only their SHA-256 in `gateway_api_keys`, with tenant, user, label, and revocation time. `cloud_sessions` maps each session to the tenant and user that created it; the session tables themselves know nothing about tenants, so every gateway query goes through this table.

```bash
# from the repository root, with ~/pi-cloud-dev/.env sourced
PI_GATEWAY_NODES=127.0.0.1:7421 tsx --tsconfig tsconfig.json packages/cloud-gateway/src/main.ts keys create --tenant acme --user alice --label laptop
PI_GATEWAY_NODES=127.0.0.1:7421 tsx --tsconfig tsconfig.json packages/cloud-gateway/src/main.ts keys list
PI_GATEWAY_NODES=127.0.0.1:7421 tsx --tsconfig tsconfig.json packages/cloud-gateway/src/main.ts keys revoke <key-hash>
PI_GATEWAY_NODES=127.0.0.1:7421 tsx --tsconfig tsconfig.json packages/cloud-gateway/src/main.ts            # serve
```

`keys create` prints the key once. `PI_GATEWAY_BOOTSTRAP_KEYS=tenant:user:key,...` installs operator-chosen keys at start so a fresh deployment has a way in; a revoked bootstrap key stays revoked.

## Configuration

`PI_GATEWAY_HOST` (default `127.0.0.1`), `PI_GATEWAY_PORT` (default 7400), `PI_PG_URL`, `PI_PG_SCHEMA` (default `pi_cloud`, must match the nodes), `PI_GATEWAY_NODES` (required, `host:port,...`), `PI_GATEWAY_NODE_TIMEOUT_MS` (default 5000), `PI_GATEWAY_BOOTSTRAP_KEYS`. The gateway creates the node's tables too, under the same advisory lock the nodes use, so either may start first.

Tests need `PI_TEST_PG_URL`; the WebSocket tests additionally need `OPEN_SANDBOX_DOMAIN` and `PI_WORKSPACES_ROOT`, and the relay test needs `PI_TEST_CLOUD_WORKER=1` because it starts a real worker.
