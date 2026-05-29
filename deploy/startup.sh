#!/usr/bin/env bash
#
# VM startup script for the Vatedge dev-agent (NanoClaw v2 fork).
# Runs as root on first boot (and is safe to re-run — idempotent).
#
# Provisions a hardened single-VM host:
#   - formats + mounts the attached data disk at /mnt/dev-agent-data
#   - installs Docker (data-root on the data disk), Node 22, pnpm, git, gh
#   - creates the `devagent` user (in the `docker` group)
#   - clones the fork to /opt/vatedge-dev-agent and symlinks state dirs onto
#     the data disk
#   - runs deploy/deploy.sh (build + container image)
#   - installs and enables the systemd unit
#
# Plan-fixed facts: project vatedge-prod, zone europe-west1-b,
# SA dev-agent@vatedge-prod, data disk google-dev-agent-data.
#
# Secrets are NOT written here — they come from Secret Manager at service boot
# (SECRETS_BACKEND=gcp), fetched via the VM's attached service account (ADC).

set -euo pipefail

# ── Operator-configurable ─────────────────────────────────────────────────────
# The fork's private git remote + branch.
REPO_HOST="github.com/vatedge-com/nano-agents.git"
REPO_URL="https://${REPO_HOST}"
REPO_BRANCH="fork-strip"

# GCP project + the Secret Manager secret holding a GitHub token with read
# access to the private fork (used only to clone; runtime secrets are fetched by
# the service via SECRETS_BACKEND=gcp).
GCP_PROJECT="vatedge-prod"
GITHUB_TOKEN_SECRET="dev-agent-github_token"

# Fixed install layout (matches deploy.sh + dev-agent.service)
INSTALL_DIR="/opt/vatedge-dev-agent"
DATA_DIR="/mnt/dev-agent-data"
DATA_DISK_DEV="/dev/disk/by-id/google-dev-agent-data"
RUN_USER="devagent"
RUN_GROUP="docker"
NODE_MAJOR="22"
# ──────────────────────────────────────────────────────────────────────────────

log() { echo "[startup $(date -u +%H:%M:%S)] $*"; }

# ── 1. Format (if blank) + mount the data disk ────────────────────────────────
log "Provisioning data disk ${DATA_DISK_DEV}"
if [ ! -b "${DATA_DISK_DEV}" ]; then
  echo "FATAL: data disk ${DATA_DISK_DEV} not attached" >&2
  exit 1
fi

# Only format if there is no filesystem yet (idempotent — never reformats data).
if ! blkid "${DATA_DISK_DEV}" >/dev/null 2>&1; then
  log "No filesystem found — formatting ext4 (first boot)"
  mkfs.ext4 -m 0 -E lazy_itable_init=0,lazy_journal_init=0,discard "${DATA_DISK_DEV}"
fi

mkdir -p "${DATA_DIR}"
DISK_UUID="$(blkid -s UUID -o value "${DATA_DISK_DEV}")"
if ! grep -q "${DISK_UUID}" /etc/fstab; then
  log "Adding data disk to /etc/fstab (nofail)"
  echo "UUID=${DISK_UUID} ${DATA_DIR} ext4 defaults,nofail 0 2" >> /etc/fstab
fi
mountpoint -q "${DATA_DIR}" || mount "${DATA_DIR}"

# Persistent subdirectories on the data disk.
mkdir -p "${DATA_DIR}"/{data,groups,store,claude-mem,docker,repo-cache}

# ── 2. Install Docker (data-root on the data disk) ────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "Installing Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin
fi

log "Pinning Docker data-root to ${DATA_DIR}/docker"
mkdir -p /etc/docker
cat > /etc/docker/daemon.json <<EOF
{
  "data-root": "${DATA_DIR}/docker"
}
EOF
systemctl enable docker
systemctl restart docker

# ── 3. Install Node 22, pnpm, git, gh ─────────────────────────────────────────
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1 | tr -d v)" != "${NODE_MAJOR}" ]; then
  log "Installing Node ${NODE_MAJOR}"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -
  apt-get install -y nodejs
fi

if ! command -v git >/dev/null 2>&1; then apt-get install -y git; fi

if ! command -v gh >/dev/null 2>&1; then
  log "Installing GitHub CLI"
  curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
  chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list
  apt-get update -y
  apt-get install -y gh
fi

# pnpm via corepack (ships with Node) — version is pinned by package.json's
# packageManager field, so corepack resolves the right one on first run.
corepack enable
corepack prepare pnpm@10.33.0 --activate

# gcloud CLI — preinstalled on Google-provided Debian images, but install it if
# the chosen image lacks it. Used here to read the GitHub token for the clone,
# and available on the host for operational use.
if ! command -v gcloud >/dev/null 2>&1; then
  log "Installing Google Cloud CLI"
  install -m 0755 -d /usr/share/keyrings
  curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg \
    | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg
  echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" \
    > /etc/apt/sources.list.d/google-cloud-sdk.list
  apt-get update -y
  apt-get install -y google-cloud-cli
fi

# ── 4. Create the run user ────────────────────────────────────────────────────
if ! id -u "${RUN_USER}" >/dev/null 2>&1; then
  log "Creating user ${RUN_USER} (group ${RUN_GROUP})"
  useradd -m -G "${RUN_GROUP}" "${RUN_USER}"
else
  usermod -aG "${RUN_GROUP}" "${RUN_USER}"
fi

# ── 5. Clone the fork + symlink state onto the data disk ──────────────────────
# Private repo: fetch a GitHub token from Secret Manager (via the VM's attached
# SA / ADC) and clone over HTTPS with it. The token is used only for the clone
# and is never written to disk or into the remote URL of the working tree.
if [ ! -d "${INSTALL_DIR}/.git" ]; then
  log "Fetching GitHub token from Secret Manager (${GITHUB_TOKEN_SECRET})"
  GH_TOKEN="$(gcloud secrets versions access latest --secret="${GITHUB_TOKEN_SECRET}" --project="${GCP_PROJECT}")"
  if [ -z "${GH_TOKEN}" ]; then
    echo "FATAL: could not read ${GITHUB_TOKEN_SECRET} from Secret Manager" >&2
    exit 1
  fi
  log "Cloning ${REPO_URL} (${REPO_BRANCH}) → ${INSTALL_DIR}"
  git clone --branch "${REPO_BRANCH}" \
    "https://x-access-token:${GH_TOKEN}@${REPO_HOST}" "${INSTALL_DIR}"
  # Reset the working-tree remote to the token-free URL so the credential never
  # persists in .git/config.
  git -C "${INSTALL_DIR}" remote set-url origin "${REPO_URL}"
  unset GH_TOKEN
fi
chown -R "${RUN_USER}:${RUN_GROUP}" "${INSTALL_DIR}"

# Persist mutable state on the data disk; the repo tree keeps only code.
for d in data groups store; do
  if [ -e "${INSTALL_DIR}/${d}" ] && [ ! -L "${INSTALL_DIR}/${d}" ]; then
    rm -rf "${INSTALL_DIR}/${d}"
  fi
  ln -sfn "${DATA_DIR}/${d}" "${INSTALL_DIR}/${d}"
done
chown -h "${RUN_USER}:${RUN_GROUP}" "${INSTALL_DIR}"/{data,groups,store}
chown -R "${RUN_USER}:${RUN_GROUP}" "${DATA_DIR}"/{data,groups,store,claude-mem}

# ── 6. Build + deploy (as devagent) ───────────────────────────────────────────
log "Running deploy.sh as ${RUN_USER}"
sudo -u "${RUN_USER}" REPO_BRANCH="${REPO_BRANCH}" bash "${INSTALL_DIR}/deploy/deploy.sh" --skip-restart

# ── 7. Install + enable the systemd unit ──────────────────────────────────────
log "Installing systemd unit"
install -m 0644 "${INSTALL_DIR}/deploy/dev-agent.service" /etc/systemd/system/dev-agent.service
systemctl daemon-reload
systemctl enable dev-agent
systemctl restart dev-agent

systemctl --no-pager status dev-agent || true
log "Startup complete"
