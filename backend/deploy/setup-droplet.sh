#!/usr/bin/env bash
# One-time setup for a fresh Ubuntu 24.04 droplet. Run as root:
#   bash deploy/setup-droplet.sh
set -euo pipefail
apt-get update
apt-get install -y ca-certificates curl ufw
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
ufw allow OpenSSH
ufw allow 80
ufw allow 443
ufw --force enable
mkdir -p data secrets
chmod 700 secrets
echo "Done. Next: cp .env.example .env, fill it in, then: docker compose up -d --build"
