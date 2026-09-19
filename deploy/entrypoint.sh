#!/bin/sh
# Role dispatcher for the control-plane image.
set -eu
cd /app
export TSX_TSCONFIG_PATH=/app/tsconfig.json
case "${1:-}" in
	gateway) shift; exec node --import tsx packages/cloud-gateway/src/main.ts "$@" ;;
	node) shift; exec node --import tsx packages/cloud-worker/src/server/entry.ts "$@" ;;
	model-proxy) shift; exec node --import tsx packages/model-proxy/src/main.ts "$@" ;;
	*) exec "$@" ;;
esac
