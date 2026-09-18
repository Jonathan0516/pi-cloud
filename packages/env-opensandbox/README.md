# @earendil-works/pi-env-opensandbox

OpenSandbox `ExecutionEnv` for `@earendil-works/pi-agent-core` harness tools. The harness keeps running where it is; `bash`, `read`, `write`, and `edit` act inside a sandbox container.

```ts
import { BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { LazySandboxProvider, OpenSandboxExecutionEnv } from "@earendil-works/pi-env-opensandbox";

const provider = new LazySandboxProvider({
  connectionConfig: { domain: "127.0.0.1:8080", apiKey: process.env.OPEN_SANDBOX_API_KEY, useServerProxy: true },
  create: {
    image: "opensandbox/code-interpreter:v1.1.0",
    timeoutSeconds: 1800,
    volumes: [{ name: "workspace", host: { path: "/data/workspaces/session-1" }, mountPath: "/workspace" }],
  },
  sandboxId: previouslyPersistedId,
  onProvisioned: async (sandbox, { reason }) => {
    // Inject credentials, clone the repository, verify tooling.
  },
});

const env = new OpenSandboxExecutionEnv({ provider, cwd: "/workspace" });
const result = await env.exec("git status --short", undefined, BACKGROUND_CONTEXT);
await env.cleanup(BACKGROUND_CONTEXT);
```

No container exists until the first operation needs one. `LazySandboxProvider` reconnects to `sandboxId` when it is still running and creates a new sandbox otherwise; persist `provider.sandboxId` to survive a restart. A transport failure marks the sandbox lost so the next call provisions again. Pass a `Sandbox` instead of a provider to reuse one the caller owns.

Commands run through an execd session under `shellPath` (default `/bin/bash`) with `shellEnv` and per-call variables applied as prefix assignments, or through `env -i` when `inheritEnv` is false. Abort and timeout interrupt the session; the reported exit code follows the Node environment's conventions, including `128 + signal` for a killed shell. Bounded output uses the core `OutputCapture`, so update batching and truncation match the Node environment. A spill preserves the complete text output in a file under `tempDirectory` (default `/tmp`) inside the sandbox, where the model can read it; output beyond `maxSpillBytes` fails the command rather than silently truncating the spill.

File operations use the execd file API. `renameFile` and `canonicalPath` shell out to `mv -f` and `realpath` because the API neither replaces a destination nor resolves symlinks. Paths are POSIX; `~` expands to `homeDirectory` (default `/root`).

Tests need a running server in `OPEN_SANDBOX_DOMAIN` (plus `OPEN_SANDBOX_API_KEY` when configured) and pull `PI_TEST_SANDBOX_IMAGE` (default `opensandbox/code-interpreter:v1.1.0`). Without the domain the sandbox suites are skipped. The shared `ExecutionEnv` conformance suite from `@earendil-works/pi-agent-core/harness/env/testing` runs against both this environment and the Node environment.
