# Deploying pi cloud (Phase 1: one EC2 host)

Everything the design's Phase 1 calls for, on one machine, with Docker Compose:

```text
                      EC2 host (Ubuntu 24.04, Docker, gVisor)
  ┌──────────────────────────────────────────────────────────────────────┐
  │  compose network                                   host network       │
  │  ┌────────────┐  ┌─────────┐  ┌──────────────┐    ┌────────────────┐  │
  │  │ pi-gateway │─▶│ pi-node │─▶│pi-model-proxy│    │opensandbox-    │  │
  │  │ :7400      │  │ :7420   │  │ :9100        │    │server :8080    │──┼─▶ sandbox containers (runsc)
  │  └────────────┘  └────┬────┘  └──────┬───────┘    └───────┬────────┘  │     /workspace ⇄ /data/workspaces/<session>
  │        │              │ host.docker.internal:8080 ────────┘           │
  │        └──────────────┴──────────────┴──────▶ postgres :5432 (loopback published for the sandbox server)
  └──────────────────────────────────────────────────────────────────────┘
                     /data (gp3 EBS): workspaces/, pg/
```

| Piece | File |
|---|---|
| Control-plane image (gateway, node, model proxy; one image, role by command) | `Dockerfile.control-plane`, `entrypoint.sh` |
| OpenSandbox lifecycle server image (from GitHub main, Docker runtime) | `Dockerfile.opensandbox-server`, `sandbox.toml` |
| Sandbox image sessions run in (code-interpreter + ripgrep, fd, pip, jq) | `sandbox/Dockerfile` |
| The stack | `compose.yaml`, `.env.example`, `model-proxy.env.example`, `postgres/init.sql` |
| Laptop variant using a host-run OpenSandbox server | `compose.local.yaml` |
| EC2 host: VPC, security group, instance, data volume, SSM role | `terraform/` |
| First boot: Docker, gVisor, `/data` | `terraform/user-data.sh` |
| Ship a checkout and start the stack over SSH | `scripts/deploy.sh` |

## Steps

1. **Provision.** In `terraform/`: `terraform init && terraform apply -var admin_cidr=<your ip>/32 -var 'client_cidrs=["<your ip>/32"]' -var key_name=<key pair>`. The first boot takes a few minutes (`/var/log/pi-cloud-user-data.done` appears when it is finished).
2. **Configure.** `cp deploy/.env.example deploy/.env` and fill in `PG_PASSWORD`, `OPEN_SANDBOX_API_KEY`, `PI_MODEL_PROXY_SECRET`, `PI_GATEWAY_BOOTSTRAP_KEYS` (at least one `tenant:user:key`), `PI_DEFAULT_MODEL`. `cp deploy/model-proxy.env.example deploy/model-proxy.env` and put the vendor API keys there; only the proxy container reads that file.
3. **Deploy.** `deploy/scripts/deploy.sh ubuntu@<public ip>`: rsyncs this checkout to `/opt/pi`, builds the sandbox image and the two service images on the host, starts the stack, and checks `/healthz`. Re-run after any change; `--no-build` skips the image builds.
4. **Use.** Open `http://<public ip>:7400/` and sign in with a bootstrap key, or run `packages/cloud-gateway/src/smoke.ts --url ws://<ip>:7400/v1/ws --key <key>`. More keys: `docker compose -f deploy/compose.yaml exec pi-gateway pi-cloud gateway keys create --tenant t --user u`.

## What is where, and why

- **Same path on both sides.** The node container mounts `/data/workspaces` at `/data/workspaces`. The worker creates `<root>/<session>` locally, then asks the OpenSandbox server to bind that host path into the sandbox at `/workspace`; the server's `allowed_host_paths` must contain it. Change all three together (`WORKSPACES_ROOT`, the compose volume, `sandbox.toml`).
- **The sandbox server is on the host network** so it can proxy to sandbox bridge IPs (`proxy.resolve_internal = true`) and so control-plane containers reach it at `host.docker.internal:8080`. It holds the Docker socket: root on the host. The design accepts this for Phase 1 only; the security group never exposes 8080, and the API key is required.
- **gVisor is on by default** (`[secure_runtime] type = "gvisor"`); `user-data.sh` installs `runsc`. On a host without it, sandbox creation fails until the table is removed from `sandbox.toml`.
- **Vendor keys exist in one container.** `model-proxy.env` is read by `pi-model-proxy` only. The node gets the minting secret and hands each worker a session-bound token; workers never see a vendor key.
- **Postgres is published on loopback only**, for the host-network sandbox server; the compose services use the `postgres` DNS name. `init.sql` creates the `opensandbox` database on first start. Gateway, node, and model proxy each create the `pi_cloud` schema and their own tables under one advisory lock, so start order does not matter. Move to RDS by pointing `PI_PG_URL` and the two DSNs at it and dropping the `postgres` service.
- **TLS is not here.** Put an ALB or Caddy in front of `:7400` before letting anyone but yourself at it; the web client's session storage sends the API key to whatever origin serves the page.

## Laptop run

With the dev OpenSandbox server already running on the host (as in `~/pi-cloud-dev`), the control plane can run containerized against it:

```bash
cd deploy && cp .env.example .env   # PG_PORT=15432, WORKSPACES_ROOT=<a path in the host server's allowed_host_paths>
docker build -t pi-sandbox:local sandbox
docker compose -f compose.yaml -f compose.local.yaml up -d --build postgres pi-model-proxy pi-node pi-gateway
```

Docker Desktop must share the workspaces path, and the host server's `allowed_host_paths` must include it.

## Phase 2 and later

Not in this directory yet: splitting the sandbox plane onto its own instances behind an internal ALB, a second control-plane node (the lease table already routes across nodes; add another `pi-node` service with a distinct `PI_NODE_ID` and advertise address, and list it in `PI_GATEWAY_NODES`), RDS Multi-AZ, S3 workspace snapshots, and the EKS runtime.
