#!/bin/bash
# First boot of the Phase 1 host (Ubuntu 24.04): Docker Engine + compose plugin, gVisor as a Docker
# runtime, the /data volume formatted and mounted, and the directories the stack expects.
# Idempotent enough to re-run by hand: bash /var/lib/cloud/instance/user-data.txt
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y ca-certificates curl gnupg rsync jq

# Docker Engine from Docker's repository (the distro package lags and lacks the compose plugin).
install -m 0755 -d /etc/apt/keyrings
if [ ! -f /etc/apt/keyrings/docker.asc ]; then
	curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
	chmod a+r /etc/apt/keyrings/docker.asc
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
fi

# gVisor (runsc): every sandbox container runs under it (deploy/sandbox.toml [secure_runtime]).
if [ ! -f /etc/apt/keyrings/gvisor.gpg ]; then
	curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /etc/apt/keyrings/gvisor.gpg
	echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/gvisor.gpg] https://storage.googleapis.com/gvisor/releases release main" > /etc/apt/sources.list.d/gvisor.list
fi

apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin runsc
runsc install # registers the "runsc" runtime in /etc/docker/daemon.json
systemctl restart docker
usermod -aG docker ubuntu

# /data: the attached gp3 volume (Terraform: /dev/sdf, which Nitro exposes as an nvme device).
# Pick the non-root disk with no filesystem; format it once; mount by UUID.
if ! mountpoint -q /data; then
	ROOT_DISK=$(lsblk -no PKNAME "$(findmnt -no SOURCE /)")
	DATA_DISK=""
	for _ in $(seq 1 30); do
		DATA_DISK=$(lsblk -dno NAME,TYPE | awk '$2=="disk"{print $1}' | grep -v "^${ROOT_DISK}$" | head -1 || true)
		[ -n "$DATA_DISK" ] && break
		sleep 2
	done
	if [ -n "$DATA_DISK" ]; then
		if [ -z "$(blkid -s TYPE -o value "/dev/$DATA_DISK" || true)" ]; then
			mkfs.ext4 -L pidata "/dev/$DATA_DISK"
		fi
		UUID=$(blkid -s UUID -o value "/dev/$DATA_DISK")
		mkdir -p /data
		grep -q "UUID=$UUID" /etc/fstab || echo "UUID=$UUID /data ext4 defaults,nofail 0 2" >> /etc/fstab
		mount /data
	else
		echo "no data disk found; using the root volume for /data" >&2
		mkdir -p /data
	fi
fi

# Workspaces are created by the node container (uid 1000) and written by sandboxes (root).
mkdir -p /data/workspaces /data/pg /opt/pi
chown 1000:1000 /data/workspaces
chown ubuntu:ubuntu /opt/pi

echo "pi cloud host ready" > /var/log/pi-cloud-user-data.done
