# @earendil-works/pi-cloud-worker (private, experimental)

The `mini` topology with its two local pieces replaced: sessions live in PostgreSQL through `@earendil-works/pi-session-backend-postgres`, and every tool runs inside an OpenSandbox sandbox through `@earendil-works/pi-env-opensandbox`. Presentations, the RPC shapes, and the lane and models services are reused from `packages/coding-agent/src/experimental/mini` unchanged.

```text
pi-cloud (tui)  ──unix socket──▶  cloud server  ──stdio──▶  worker (one per session)
                                   PostgreSQL catalog         PostgresSessionRepo
                                                              OpenSandboxExecutionEnv ──▶ sandbox
                                                                                          /workspace ⇄ $PI_WORKSPACES_ROOT/<session>
```

Configuration is read from the environment: `PI_PG_URL`, `PI_PG_SCHEMA` (default `pi_cloud`), `OPEN_SANDBOX_DOMAIN`, `OPEN_SANDBOX_API_KEY`, `PI_SANDBOX_IMAGE`, `PI_SANDBOX_TIMEOUT_SECONDS` (default 1800), and `PI_WORKSPACES_ROOT`. The server creates the schema and tables on start. Model credentials come from the local `pi` configuration, as in `mini`.

```bash
# from the repository root, with ~/pi-cloud-dev/.env sourced
tsx --tsconfig tsconfig.json packages/cloud-worker/src/main.ts            # new session
tsx --tsconfig tsconfig.json packages/cloud-worker/src/main.ts --continue # newest session
tsx --tsconfig tsconfig.json packages/cloud-worker/src/smoke.ts "list /workspace and create hello.txt"
tsx --tsconfig tsconfig.json packages/cloud-worker/src/smoke.ts --kill-after 4000 "run: sleep 20; echo done"
```

Every worker holds its session's lease (`PI_LEASE_TTL_SECONDS`, default 30; `PI_LEASE_HEARTBEAT_MS`, default 5000). A second worker for the same session fails to start while the lease is live, and a worker whose lease is taken over exits with code 75 the moment a commit or heartbeat is fenced. Taking over an expired lease kills the previous worker's sandbox before provisioning a new one, so a stalled predecessor cannot keep writing into the workspace; a released lease reconnects to the running sandbox instead.

No sandbox exists until the first tool call. The worker remembers the sandbox id in the session (`cloud.sandbox` value), so a replacement worker reconnects to the running sandbox; when it has expired, a new one mounts the same host workspace. Killing a worker mid-run and reattaching resumes the open operation from its durable restart point, exactly as `mini` does.

Tests need `PI_TEST_PG_URL`, `OPEN_SANDBOX_DOMAIN`, and `PI_WORKSPACES_ROOT`; the attach test additionally needs `PI_TEST_CLOUD_WORKER=1` because a worker requires real model credentials.
