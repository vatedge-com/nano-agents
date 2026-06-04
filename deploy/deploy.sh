#!/usr/bin/env bash
#
# Redeploy the Vatedge dev-agent. Runs as the `devagent` user.
#
#   - pulls the configured branch (hard reset to origin)
#   - installs deps with the frozen lockfile (supply-chain policy)
#   - builds the host TypeScript
#   - rebuilds the agent container image
#   - restarts the systemd service and verifies it came up
#
# Invoked by startup.sh on first boot (with --skip-restart, since the unit is
# installed/started afterward) and run directly for subsequent redeploys.

set -euo pipefail

INSTALL_DIR="/opt/vatedge-dev-agent"
# Branch is passed in by startup.sh; defaults match startup.sh for manual redeploys.
REPO_BRANCH="${REPO_BRANCH:-main}"
GCP_PROJECT="${GCP_PROJECT:-vatedge-prod}"
GITHUB_TOKEN_SECRET="${GITHUB_TOKEN_SECRET:-dev-agent-github_token}"

SKIP_RESTART=0
for arg in "$@"; do
  case "$arg" in
    --skip-restart) SKIP_RESTART=1 ;;
  esac
done

log() { echo "[deploy $(date -u +%H:%M:%S)] $*"; }

cd "${INSTALL_DIR}"

log "Fetching + resetting to origin/${REPO_BRANCH}"
# Private repo: read a GitHub token from Secret Manager (via the VM's attached
# SA / ADC) and pass it as an ephemeral auth header for this fetch only — it is
# never written to .git/config or disk.
GH_TOKEN="$(gcloud secrets versions access latest --secret="${GITHUB_TOKEN_SECRET}" --project="${GCP_PROJECT}")"
GH_BASIC="$(printf 'x-access-token:%s' "${GH_TOKEN}" | base64 | tr -d '\n')"
git -c "http.https://github.com/.extraheader=AUTHORIZATION: basic ${GH_BASIC}" fetch origin "${REPO_BRANCH}"
unset GH_TOKEN GH_BASIC
git checkout "${REPO_BRANCH}"
git reset --hard "origin/${REPO_BRANCH}"

log "Installing dependencies (frozen lockfile)"
pnpm install --frozen-lockfile

log "Building host"
pnpm run build

log "Building agent container image"
./container/build.sh

if [ "${SKIP_RESTART}" -eq 1 ]; then
  log "Skipping service restart (--skip-restart)"
  exit 0
fi

# Reconcile git-driven per-group container config into the central DB. Runs only
# in the normal redeploy path (the service has run before, so the DB is migrated
# and groups exist). No-op if groups.config.json is absent. Non-fatal: a config
# hiccup must never block the code deploy + restart — it is logged loudly instead.
log "Reconciling group container-config from groups.config.json"
if ! pnpm exec tsx scripts/reconcile-container-configs.ts apply; then
  log "WARN: group-config reconcile failed — continuing with code deploy"
fi

log "Restarting dev-agent service"
sudo systemctl restart dev-agent
sleep 2
if systemctl is-active --quiet dev-agent; then
  log "dev-agent is active"
else
  log "ERROR: dev-agent failed to start"
  systemctl --no-pager status dev-agent || true
  exit 1
fi
