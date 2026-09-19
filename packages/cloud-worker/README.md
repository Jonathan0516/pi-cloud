# @earendil-works/pi-cloud-worker (private, experimental)

The `mini` topology with its two local pieces replaced: sessions live in PostgreSQL through `@earendil-works/pi-session-backend-postgres`, and every tool runs inside an OpenSandbox sandbox through `@earendil-works/pi-env-opensandbox`. Presentations, the RPC shapes, and the lane and models services are reused from `packages/coding-agent/src/experimental/mini` unchanged.

```text
pi-cloud (tui)  ──unix socket──▶  node (supervisor)  ──stdio──▶  worker (one per session)
                                   PostgreSQL catalog              PostgresSessionRepo + lease
                  ──TCP──▶         other nodes (relay by lease)    OpenSandboxExecutionEnv ──▶ sandbox
                                   reaper, idle sweep                                          /workspace ⇄ $PI_WORKSPACES_ROOT/<session>
```

Configuration is read from the environment: `PI_PG_URL`, `PI_PG_SCHEMA` (default `pi_cloud`), `OPEN_SANDBOX_DOMAIN`, `OPEN_SANDBOX_API_KEY`, `PI_SANDBOX_IMAGE`, `PI_SANDBOX_TIMEOUT_SECONDS` (default 600), `PI_WORKSPACES_ROOT`, and `PI_BUNDLE_CACHE_DIR` (default `<PI_WORKSPACES_ROOT>/.bundles`). The server creates the schema and tables on start. Model credentials come from the local `pi` configuration, as in `mini`.

```bash
# from the repository root, with ~/pi-cloud-dev/.env sourced
tsx --tsconfig tsconfig.json packages/cloud-worker/src/main.ts            # new session
tsx --tsconfig tsconfig.json packages/cloud-worker/src/main.ts --continue # newest session
tsx --tsconfig tsconfig.json packages/cloud-worker/src/smoke.ts "list /workspace and create hello.txt"
tsx --tsconfig tsconfig.json packages/cloud-worker/src/smoke.ts --kill-after 4000 "run: sleep 20; echo done"
```

Every worker holds its session's lease (`PI_LEASE_TTL_SECONDS`, default 30; `PI_LEASE_HEARTBEAT_MS`, default 5000). A second worker for the same session fails to start while the lease is live, and a worker whose lease is taken over exits with code 75 the moment a commit or heartbeat is fenced. Taking over an expired lease kills the previous worker's sandbox before provisioning a new one, so a stalled predecessor cannot keep writing into the workspace; a released lease reconnects to the running sandbox instead.

With `PI_MODEL_PROXY_URL` and `PI_MODEL_PROXY_SECRET` set, the server mints one token per worker, bound to the worker's session (`PI_MODEL_PROXY_TOKEN_TTL_SECONDS`, default 24h), spawns the worker with every vendor credential and the minting secret stripped from its environment, and the worker addresses every model through the proxy (`PI_MODEL_PROXY_PROVIDERS`, default `anthropic,openai,deepseek`; `PI_DEFAULT_MODEL` picks the initial `provider/modelId`). The proxy holds the vendor keys and meters calls into `billing_events`; see `packages/model-proxy`. Without the proxy variables, workers use the local pi credentials as before.

## Nodes

The server is a node. It listens on TCP (`PI_NODE_LISTEN_HOST`, default `127.0.0.1`; `PI_NODE_LISTEN_PORT`, default `0` for any free port) as well as on the CLI's unix socket, and identifies itself as `PI_NODE_ID` (default `<hostname>:<pid>`). A deployed node sets all three explicitly, plus `PI_NODE_ADVERTISE_ADDR` when it binds a wildcard address. Every lease a worker takes records the node and the address it advertises (`PI_NODE_ADVERTISE_ADDR`, default the bound `host:port`), so any node can find where a session runs by reading the lease table.

- **Routing.** A presentation attaches to whichever node it reaches. If the session's lease is held by a live worker on another node, the node relays the presentation there over TCP instead of spawning a second worker. If the lease is free or expired, the node spawns a local worker, which takes the lease.
- **Idle sweep.** A worker is stopped only when nobody is attached *and* its lane has been idle for `PI_WORKER_IDLE_GRACE_MS` (default 30s). Closing the TUI mid-run does not stop the run; the worker finishes it and only then retires, releasing the lease.
- **Reaper.** Every `PI_REAPER_INTERVAL_MS` (default 5s, `0` disables) a node looks for sessions with an open operation and no live holder (an expired lease from a dead node, or a released one from a drained node) and resumes at most `PI_REAPER_TAKEOVERS_PER_TICK` (default 2) of them, oldest failures last. The single-statement lease acquire decides races between nodes. A session whose resume fails `PI_POISON_THRESHOLD` times (default 3) is marked faulted in `cloud_session_recovery` and left alone until an operator clears the row.
- **Lifetime.** With `PI_NODE_PERSISTENT=1` the node keeps running when it has nothing to do; the CLI starts a non-persistent one on demand that retires when it is idle.

Two nodes on one machine, for a takeover rehearsal:

```bash
PI_NODE_ID=a PI_NODE_LISTEN_PORT=7421 PI_NODE_PERSISTENT=1 PI_LEASE_TTL_SECONDS=5 PI_LEASE_HEARTBEAT_MS=1000 \
  tsx --tsconfig tsconfig.json packages/cloud-worker/src/server/entry.ts /tmp/pi-node-a.sock &
PI_NODE_ID=b PI_NODE_LISTEN_PORT=7422 PI_NODE_PERSISTENT=1 PI_REAPER_INTERVAL_MS=1000 \
  tsx --tsconfig tsconfig.json packages/cloud-worker/src/server/entry.ts /tmp/pi-node-b.sock &
tsx --tsconfig tsconfig.json packages/cloud-worker/src/smoke.ts --socket /tmp/pi-node-a.sock "run: sleep 30; echo done"
# kill node a and its worker mid-run; b's reaper resumes the session once the lease expires
tsx --tsconfig tsconfig.json packages/cloud-worker/src/main.ts --socket /tmp/pi-node-b.sock --session <id>
```

## Resource bundles

A bundle is the skills, prompt templates, and prompt files a tenant's sessions run with. It is immutable and content-addressed: `version = sha256(manifest)`, and the manifest hashes every file, so one version names exactly one set of bytes. Bundles live in `resource_bundles`, each tenant's current default in `tenant_bundles`; the gateway publishes and sets them (see `packages/cloud-gateway`).

```text
SYSTEM.md                  replaces the default system prompt
APPEND_SYSTEM.md, append/*.md   appended, in path order
AGENTS.md                  project instructions, appended under a heading
skills/<name>/SKILL.md     frontmatter: name, description, disable-model-invocation
prompts/<name>.md          frontmatter: description
extensions/                listed in the manifest but never loaded: tenant code does not run in a worker
```

A session records its tenant (`cloud.tenant/id`) and the bundle it is pinned to (`cloud.bundle/version`). At start the worker materializes that version into the node cache (`PI_BUNDLE_CACHE_DIR`, default `<PI_WORKSPACES_ROOT>/.bundles`), verifying every file against the manifest, and mounts the directory read-only at `/opt/pi/bundle` in the session's sandbox. Skills are listed in the system prompt with that mounted path, so the model's `read` tool finds them where the prompt says they are. A complete cache directory is trusted without re-hashing, because a version can never change.

Upgrades happen only at idle boundaries, and only when the tenant's new default registers every entry type the session already holds (`planTakeovers`' sibling, `planBundleUpgrade`). A session with an open operation keeps its pinned version, so a worker never resumes an operation with code that cannot recognize its entries. When the pin moves, the remembered sandbox is discarded: it has the old bundle mounted.

## Reclaiming workspaces

A session's `/workspace` is a host directory that outlives its sandbox on purpose: the sandbox is disposable, the work in it is not. Nothing else deletes those directories, so every node sweeps its workspaces root every `PI_WORKSPACE_GC_INTERVAL_MS` (default one hour, plus once five seconds after start).

A directory is removed only when no worker holds the session and either its session row is gone (deleted through the gateway) or the session has been idle longer than `PI_WORKSPACE_RETENTION_DAYS` (default 14; `0` disables reclamation entirely). A directory with no session row must also be at least an hour old, so a session being created right now is never caught. Dot-directories are skipped, which is what keeps the bundle cache safe where it sits under the same root. The decision is `planWorkspaceCleanup`, a pure function, so the dangerous half is tested without a filesystem.

No sandbox exists until the first tool call. The worker remembers the sandbox id in the session (`cloud.sandbox` value), so a replacement worker reconnects to the running sandbox; when it has expired, a new one mounts the same host workspace. Killing a worker mid-run and reattaching resumes the open operation from its durable restart point, exactly as `mini` does.

Tests need `PI_TEST_PG_URL`, `OPEN_SANDBOX_DOMAIN`, and `PI_WORKSPACES_ROOT`; the attach, relay, idle sweep, and reaper tests additionally need `PI_TEST_CLOUD_WORKER=1` because a worker requires real model credentials. The takeover planner and the worker environment are unit tested without either.
