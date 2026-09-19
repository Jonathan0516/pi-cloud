#!/usr/bin/env bash
# Ship this checkout to a Phase 1 host and (re)start the stack there.
#   deploy/scripts/deploy.sh ubuntu@<host> [--no-build]
# Needs deploy/.env (and optionally deploy/model-proxy.env) filled in locally; both are copied to
# the host with mode 600 and never committed.
set -euo pipefail
HOST=${1:?usage: deploy.sh user@host [--no-build]}
BUILD=1
[ "${2:-}" = "--no-build" ] && BUILD=0
ROOT=$(cd "$(dirname "$0")/../.." && pwd)
REMOTE_DIR=/opt/pi

[ -f "$ROOT/deploy/.env" ] || { echo "deploy/.env is missing; copy deploy/.env.example and fill it in" >&2; exit 1; }

echo "== sync sources to $HOST:$REMOTE_DIR"
rsync -az --delete \
	--exclude .git --exclude .claude --exclude node_modules --exclude '**/node_modules' \
	--exclude '**/dist' --exclude .artifacts --exclude '*.log' \
	--exclude deploy/.env --exclude deploy/model-proxy.env --exclude 'deploy/terraform/.terraform' --exclude 'deploy/terraform/*.tfstate*' \
	"$ROOT/" "$HOST:$REMOTE_DIR/"
rsync -az --chmod=F600 "$ROOT/deploy/.env" "$HOST:$REMOTE_DIR/deploy/.env"
if [ -f "$ROOT/deploy/model-proxy.env" ]; then
	rsync -az --chmod=F600 "$ROOT/deploy/model-proxy.env" "$HOST:$REMOTE_DIR/deploy/model-proxy.env"
fi

echo "== build and start"
# shellcheck disable=SC2029
ssh "$HOST" "set -e; cd $REMOTE_DIR/deploy
	if [ $BUILD = 1 ]; then
		docker build -t pi-sandbox:local sandbox
		docker compose -f compose.yaml build
	fi
	docker compose -f compose.yaml up -d --remove-orphans
	docker compose -f compose.yaml ps"

echo "== health"
GATEWAY_PORT=$(grep -E '^GATEWAY_PORT=' "$ROOT/deploy/.env" | cut -d= -f2)
# shellcheck disable=SC2029
ssh "$HOST" "curl -fsS http://127.0.0.1:${GATEWAY_PORT:-7400}/healthz && echo && curl -fsS http://127.0.0.1:8080/health && echo"
echo "gateway: http://${HOST#*@}:${GATEWAY_PORT:-7400}/"
