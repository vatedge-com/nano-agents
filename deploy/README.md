# Vatedge dev-agent — VM deploy runbook

Hardened single-VM production deploy of the NanoClaw v2 fork. The GCP resources
(project, service account, data disk, Secret Manager secrets) already exist —
this runbook covers VM creation, first boot, and redeploys.

## Fixed facts

| Thing | Value |
|-------|-------|
| Project | `vatedge-prod` |
| Zone | `europe-west1-b` |
| Service account | `dev-agent@vatedge-prod.iam.gserviceaccount.com` |
| Data disk | `dev-agent-data` (attached as `/dev/disk/by-id/google-dev-agent-data`) |
| Data mount | `/mnt/dev-agent-data` |
| Install dir | `/opt/vatedge-dev-agent` |
| Run user / group | `devagent` / `docker` |
| Service | `dev-agent.service` (systemd) |

## Pieces

| File | Role |
|------|------|
| `startup.sh` | Root, idempotent VM startup script. Mounts the data disk, installs Docker/Node/pnpm/git/gh, creates `devagent`, clones the fork, symlinks `data/groups/store` onto the data disk, runs `deploy.sh`, installs+enables the systemd unit. |
| `deploy.sh` | Redeploy path (runs as `devagent`): `git reset --hard origin/main`, `pnpm install --frozen-lockfile`, `pnpm run build`, `./container/build.sh`, reconcile group config (`groups.config.json` → DB, non-fatal), restart service. |
| `.github/workflows/deploy.yml` | Push-to-`main` auto-deploy: gated on green CI, authenticates via Workload Identity Federation, IAP-SSHes in as `devagent`, runs `deploy.sh`. |
| `dev-agent.service` | systemd unit. `SECRETS_BACKEND=gcp`, `GCP_PROJECT=vatedge-prod`, `CLAUDE_MEM_PLUGIN_DIR=/mnt/dev-agent-data/claude-mem`. No secret env file. |

## Before first boot — confirm these

1. `startup.sh`: `REPO_URL` / `REPO_BRANCH` (defaults: the private fork, `main`).
2. `deploy.sh`: `REPO_BRANCH` default matches (`main`).

## Secrets (GCP Secret Manager)

The host runs with `SECRETS_BACKEND=gcp`. At boot it fetches each secret via the
VM's attached service account (Application Default Credentials — no key file).
Secrets are named `dev-agent-<lowercased_key>`, version `latest`:

| ScopedSecrets key | Secret Manager name |
|-------------------|---------------------|
| CLAUDE_CODE_OAUTH_TOKEN | `dev-agent-claude_code_oauth_token` |
| GITHUB_TOKEN | `dev-agent-github_token` |
| SLACK_BOT_TOKEN | `dev-agent-slack_bot_token` |
| SLACK_APP_TOKEN | `dev-agent-slack_app_token` |
| SLACK_SIGNING_SECRET | `dev-agent-slack_signing_secret` |
| SLACK_TEAM_ID | `dev-agent-slack_team_id` |
| CLICKUP_API_TOKEN | `dev-agent-clickup_api_token` |
| CLICKUP_TEAM_ID | `dev-agent-clickup_team_id` |

A missing/empty secret is tolerated and skipped (it won't crash the host).
`GOOGLE_APPLICATION_CREDENTIALS` is NOT a Secret Manager fetch — if needed it
stays an on-disk path supplied via env.

The service account needs `roles/secretmanager.secretAccessor` on each secret.

### Slack app-level token (required for Socket Mode)

The Slack adapter prefers **Socket Mode** (outbound WebSocket — no public
webhook endpoint). For that, `SLACK_APP_TOKEN` must be a Slack **app-level
token** (`xapp-…`) with the `connections:write` scope, created under the Slack
app's *Basic Information → App-Level Tokens*, and Socket Mode must be enabled in
the app config.

- If `dev-agent-slack_app_token` is present and starts with `xapp-`, the host
  uses Socket Mode.
- If absent/empty, the host falls back to the inbound Events-API webhook adapter
  (which requires a public URL). For a VM with no inbound ingress, set the
  app-level token.

`SLACK_SIGNING_SECRET` is still required in Socket Mode — the adapter re-injects
each Socket Mode envelope through the existing signed-webhook code path, so it
signs the forged request with the signing secret internally.

## VM creation (gcloud)

```bash
gcloud compute instances create dev-agent \
  --project=vatedge-prod \
  --zone=europe-west1-b \
  --machine-type=e2-standard-4 \
  --service-account=dev-agent@vatedge-prod.iam.gserviceaccount.com \
  --scopes=cloud-platform \
  --image-family=debian-12 --image-project=debian-cloud \
  --disk=name=dev-agent-data,device-name=dev-agent-data,mode=rw,auto-delete=no \
  --metadata-from-file=startup-script=deploy/startup.sh
```

> The `--disk device-name=dev-agent-data` is what makes the disk appear at
> `/dev/disk/by-id/google-dev-agent-data`, which `startup.sh` expects.
> `--scopes=cloud-platform` (plus the SA's IAM role) is what lets ADC read
> Secret Manager.

## First boot

`startup.sh` runs automatically as root. It is idempotent — safe to re-run via
`sudo google_metadata_script_runner startup`. Watch it:

```bash
gcloud compute ssh dev-agent --zone=europe-west1-b
sudo journalctl -u google-startup-scripts -f      # provisioning
sudo journalctl -u dev-agent -f                    # the host service
systemctl is-active dev-agent
```

## Redeploy (new code)

```bash
gcloud compute ssh dev-agent --zone=europe-west1-b
sudo -u devagent REPO_BRANCH=main bash /opt/vatedge-dev-agent/deploy/deploy.sh
```

`deploy.sh` fetches + hard-resets the branch, installs with the frozen lockfile,
rebuilds the host and the agent container image, reconciles group config, then
restarts and verifies the service.

## Automated deploy (push to `main`)

`main` is the canonical mainline and the deployed branch. Merging to `main`
deploys automatically:

```
push to main → CI (.github/workflows/ci.yml) → green → Deploy (deploy.yml)
                                                          │
                              WIF auth (no stored key) → IAP SSH as devagent
                                                          │
                                          REPO_BRANCH=main bash deploy/deploy.sh
```

- **Gate:** `deploy.yml` triggers via `workflow_run` on a *successful* CI run on
  `main`, so a red CI never deploys. `concurrency: deploy-prod` serialises deploys.
- **Auth:** Workload Identity Federation — GitHub's OIDC token impersonates
  `dev-agent-deployer@vatedge-prod.iam.gserviceaccount.com` (no SA key stored).
  Repo vars `GCP_WIF_PROVIDER` + `GCP_DEPLOY_SA` point at the pool/provider.
- **Deployer SA IAM (minimal):** custom role `devAgentDeployer`
  (`compute.instances.get`/`list`/`setMetadata`, `compute.projects.get`,
  `compute.zones.get`, `compute.zoneOperations.get`) + `roles/iap.tunnelResourceAccessor`
  + `roles/iam.serviceAccountUser` on the VM's attached `dev-agent@` SA (required to
  set instance metadata / push the ephemeral SSH key).
- **Unattended restart:** `deploy.sh`'s only privileged step is
  `sudo systemctl restart dev-agent`; `/etc/sudoers.d/dev-agent-deploy` grants
  `devagent` NOPASSWD for exactly that one command (installed by `startup.sh`).
- **Manual trigger / smoke test:** `gh workflow run deploy.yml --ref main`
  (`deploy.yml` also has `workflow_dispatch`).

### Group config (`groups.config.json`)

Per-group container config (model, skills, MCP servers, packages, mounts) is
git-driven. `deploy.sh` runs `scripts/reconcile-container-configs.ts apply`, which
upserts each entry (keyed by group **folder**) into the `container_configs` DB.
It is **upsert-only** — never deletes groups, never touches runtime state
(`tasks/`, `CLAUDE.local.md`) or the runtime-derived `image_tag`. Bootstrap/inspect:

```bash
# Regenerate the file from the live DB (on the VM):
pnpm exec tsx scripts/reconcile-container-configs.ts export --write
# Preview a change without writing:
pnpm exec tsx scripts/reconcile-container-configs.ts apply --dry-run
```

A reconciled change takes effect on the group's next container spawn.

## State on the data disk

`/mnt/dev-agent-data/{data,groups,store}` are symlinked back into the install
dir, so a redeploy (or even a fresh re-clone) never loses session DBs, group
config, or the object store. `claude-mem`, `docker` (Docker data-root), and
`repo-cache` also live on the data disk.
