# Sandbox image for coding sessions: OpenSandbox's code interpreter (Ubuntu 24.04, Python 3, Node 22,
# git, execd) plus the tools pi's tools expect: ripgrep, fd, pip, jq.
#
#   docker build -t pi-sandbox:local deploy/sandbox
# Push to a registry the sandbox host can pull from, then set PI_SANDBOX_IMAGE.

FROM opensandbox/code-interpreter:v1.1.0

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ripgrep fd-find jq unzip python3-pip python3-venv build-essential \
	&& ln -sf /usr/bin/fdfind /usr/local/bin/fd \
	&& rm -rf /var/lib/apt/lists/*

# Sessions work here; the host workspace directory is bind-mounted over it.
WORKDIR /workspace
