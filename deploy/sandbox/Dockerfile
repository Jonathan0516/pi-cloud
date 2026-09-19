# Sandbox image for coding sessions.
#
# Built from node:22-bookworm-slim rather than opensandbox/code-interpreter, which is 10.4 GB
# because it carries a Jupyter and data-science stack a coding agent never touches. The server
# copies execd, bootstrap.sh and bwrap into the container at start and overrides the entrypoint,
# so a sandbox image needs no OpenSandbox pieces of its own: only a glibc userland (execd is
# dynamically linked, so no Alpine) and a shell.
#
#   docker build -t pi-sandbox:local deploy/sandbox
# Push to a registry the sandbox host can pull from, then set PI_SANDBOX_IMAGE.

FROM node:22-bookworm-slim

# What an agent reaches for: a shell and coreutils, git, the search tools, a Python, and a
# toolchain so `npm install` with native modules does not fail deep inside node-gyp.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends \
		bash ca-certificates coreutils curl file git jq less procps \
		ripgrep fd-find unzip xz-utils \
		python3 python3-pip python3-venv \
		build-essential \
	&& ln -sf /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*

# Sessions work here; the host workspace directory is bind-mounted over it.
WORKDIR /workspace
