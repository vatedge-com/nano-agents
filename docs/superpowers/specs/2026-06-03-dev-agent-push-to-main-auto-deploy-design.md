# Dev-Agent: push-to-`main` auto-deploy — design spec

**Date:** 2026-06-03
**Status:** Approved design, pending implementation plan
**Repo:** `vatedge-dev-agent` (NanoClaw fork, `github.com/vatedge-com/nano-agents`)

## Problem

Deploying a new dev-agent version is a manual, pull-based operation: someone SSHes
into the prod GCE VM and runs `deploy/deploy.sh`, which hard-resets the VM checkout
to `origin/fork-strip`, installs deps, builds, rebuilds the container image, and
restarts the systemd service. We want **"merge to mainline → it deploys"** with no
manual step.

A second ask — "deploy the groups too" — is **in scope**: per-group container config
(MCP servers, model, skills, packages, mounts) is git-driven via a committed
desired-state file reconciled into the prod DB on deploy. See
[Part 4 — git-driven group config](#part-4--git-driven-group-config-x).

## Background — what actually exists today

- **Deploy is pull-based and manual.** `deploy/deploy.sh` runs *on the VM* as the
  `devagent` user: fetch (auth via a GitHub token from Secret Manager) →
  `git checkout $REPO_BRANCH` → `git reset --hard origin/$REPO_BRANCH` →
  `pnpm install --frozen-lockfile` → `pnpm run build` → `./container/build.sh` →
  `sudo systemctl restart dev-agent` → verify `systemctl is-active`. Nothing triggers
  it on push.
- **Branch mismatch.** The VM deploys `fork-strip` (set in `deploy/startup.sh` and
  `deploy/deploy.sh`, default `REPO_BRANCH=fork-strip`). CI (`.github/workflows/ci.yml`)
  runs only on `pull_request: branches: [main]`. `fork-strip` is `main` + 5 commits
  with **no divergence** — `main` is a clean fast-forward ancestor.
- **Group config is DB-backed, not file-backed.** Since migration `014-container-configs`,
  per-group container config (MCP servers, mounts, model, skills selection, name) lives
  in `data/v2.db` → `container_configs` table, authored via the `groups` CLI. The
  `groups/<folder>/container.json` file is **materialized from the DB at spawn time**
  (`container-runner.ts`), and the group's `CLAUDE.md` / `.claude-fragments/` are
  **composed at spawn** from `src/modules/*` (the "do not edit" header confirms this).
  `data/` and `groups/*` are gitignored.
- **Known wrinkle:** `deploy.sh`'s `sudo systemctl restart dev-agent` currently needs a
  manual `sudo` as the SSH user, which blocks unattended runs.

## Goals

1. Pushing to the mainline branch deploys the dev-agent automatically, gated on green CI.
2. No long-lived service-account key stored in GitHub.
3. The deploy is unattended end-to-end (fix the sudo wrinkle).
4. One canonical mainline branch, aligned with CI.

## Non-goals

- Git-driving per-group **runtime state** — `tasks/*.json` (live tasks) and
  `CLAUDE.local.md` (per-group memory the agent writes) are never touched.
- Auto-**creating** or **deleting** agent groups from the file. Reconcile is
  upsert-only against groups that already exist in the DB.
- Multi-environment / staging deploy of the dev-agent (it is prod-only, one VM).
- Changing the agent's runtime behavior, container image contents, or secrets backend.

## Design

### Part 1 — Branch consolidation (one-time)

- **Fast-forward `origin/main` → `fork-strip`** (clean FF; `fork-strip` is `main` + 5,
  no divergence).
- **Repoint the VM deploy branch** `fork-strip` → `main`:
  - Change the `REPO_BRANCH` default in `deploy/deploy.sh` and `deploy/startup.sh`
    from `fork-strip` to `main`.
  - On the live VM, `git checkout main` in `/opt/vatedge-dev-agent` so the next
    `reset --hard origin/main` is correct.
- **Retire `fork-strip`** — delete the remote branch after the FF so there is a single
  mainline. All future work merges into `main` via PR (already CI-gated).

### Part 2 — Auto-deploy workflow

- **Gate on CI.** Add `push: branches: [main]` to the existing `ci.yml` so CI also runs
  on the merge commit (today it runs only on PRs).
- **New `.github/workflows/deploy.yml`** triggered by the standard `workflow_run` pattern:
  ```yaml
  on:
    workflow_run:
      workflows: ["CI"]
      types: [completed]
      branches: [main]
  ```
  The deploy job runs only if `github.event.workflow_run.conclusion == 'success'`.
  → **Green CI is a hard precondition for deploy.**
- **Auth: Workload Identity Federation** (no stored key). A dedicated deploy service
  account (e.g. `dev-agent-deployer@vatedge-prod.iam`) with:
  - `roles/iap.tunnelResourceAccessor` (IAP TCP tunnel to the VM),
  - OS Login access (`roles/compute.osLogin`) **or** the ability to SSH as `devagent`,
  - `roles/compute.viewer` (to resolve the instance).
  GitHub Actions authenticates via `google-github-actions/auth` using the WIF provider
  bound to this repo.
- **Deploy step** (single SSH command, runs the existing script):
  ```bash
  gcloud compute ssh "<SSH_TARGET>@<INSTANCE_NAME>" \
    --project vatedge-prod \
    --zone "<ZONE>" \
    --tunnel-through-iap \
    --command 'REPO_BRANCH=main bash /opt/vatedge-dev-agent/deploy/deploy.sh'
  ```
  `deploy.sh` already exits non-zero if the service fails to come up, so a failed deploy
  turns the Action red.
- **Concurrency guard** so two pushes cannot deploy on top of each other:
  ```yaml
  concurrency:
    group: deploy-prod
    cancel-in-progress: false
  ```

### Part 3 — Fix the sudo wrinkle (durable)

Add `/etc/sudoers.d/dev-agent-deploy` granting the SSH user passwordless sudo for
**exactly** the commands `deploy.sh` needs unattended:

```
devagent ALL=(root) NOPASSWD: /usr/bin/systemctl restart dev-agent
```

(If `container/build.sh` or a `docker kill` of the warm container also needs root in the
non-interactive path, scope those in the same drop-in with explicit absolute paths — no
blanket `NOPASSWD: ALL`.) This is what makes the unattended Action actually work and is
the durable fix for the standing manual-sudo issue.

### Part 4 — git-driven group config (X)

Per-group container config (the `container_configs` DB rows: `model`, `skills`,
`mcp_servers`, `packages_*`, `additional_mounts`, `assistant_name`, `provider`,
`cli_scope`, `max_messages_per_prompt`) becomes git-driven via a committed desired-state
file reconciled into the prod DB during deploy.

**Desired-state file — `groups.config.json` (repo root, tracked):** keyed by group
**folder** (stable, human-chosen) — *never* by `agent_group_id` (install-specific UUID):

```jsonc
{
  "version": 1,
  "groups": {
    "main": {
      "model": "opus",
      "skills": "all",
      "provider": null,
      "assistantName": "Nano",
      "cliScope": "global",
      "maxMessagesPerPrompt": null,
      "mcpServers": { "slack": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-slack"], "env": { "SLACK_BOT_TOKEN": "$SLACK_BOT_TOKEN" } } },
      "packages": { "apt": [], "npm": [] },
      "additionalMounts": [ { "hostPath": "/opt/vatedge-dev-agent/secrets/gcp-staging.json", "containerPath": "secrets/gcp-staging.json", "readonly": true } ]
    }
  }
}
```

Mounts use **VM-absolute paths** (the file is the prod desired state; reconcile only ever
runs on the VM). No local-machine paths are committed.

**Reconcile tool — `scripts/reconcile-container-configs.ts`** (Node host, run via
`pnpm exec tsx`), modelled on `src/backfill-container-configs.ts`. Three modes:

- `export` — dump the current DB `container_configs` to `groups.config.json` shape (used
  once to **bootstrap** the file accurately from the live prod DB, so the first `apply`
  is a no-op).
- `apply` — for each folder in the file, resolve `folder → agent_group_id` via
  `getAllAgentGroups()`, `ensureContainerConfig(id)`, then `updateContainerConfigScalars`
  + `updateContainerConfigJson` for exactly the fields present. **Upsert-only.**
- `--dry-run` — print a per-group field-level diff (current vs desired) and exit without
  writing.

**Safety invariants:**
- **Upsert-only, never delete.** A group in the DB but absent from the file is left
  untouched (logged). A folder in the file with no matching DB group is a no-op warning
  (never auto-creates a group).
- **No runtime state touched** — only `container_configs` columns; never `tasks/` or
  `CLAUDE.local.md`.
- **`agent_group_id`, `created_at`, session state are never written.**
- A reconcile change takes effect on the group's **next container spawn** (config is
  materialized to `container.json` at spawn). Optionally pair with
  `ncl groups restart --id <id>` if an immediate pickup is wanted; not automated here.

**Wiring into `deploy.sh`** — after build, before restart:

```bash
log "Reconciling group container-config from groups.config.json"
pnpm exec tsx scripts/reconcile-container-configs.ts apply
```

Persona/instruction changes (`src/modules/*` fragments) continue to ship with the code
deploy via the normal build → spawn-time compose path — unchanged.

### Rollback

- **Primary:** `git revert <bad-commit>` + push → re-deploys the prior state through the
  same gated pipeline.
- **Manual fallback:** SSH to the VM and run
  `REPO_BRANCH=main bash /opt/vatedge-dev-agent/deploy/deploy.sh` after checking out a
  known-good ref, or hard-reset the VM checkout to a specific commit.

## Testing & verification

All commands assume `gcloud config set project vatedge-prod` (or pass `--project
vatedge-prod`). Resolve the placeholders first.

### 0. Resolve deployment parameters

```bash
# Instance name + zone (fill INSTANCE_NAME / ZONE below from this)
gcloud compute instances list --project vatedge-prod \
  --filter="name~dev-agent" \
  --format="table(name, zone, status)"

# Does the VM use OS Login? (chooses SSH_TARGET: OS Login login name vs 'devagent')
gcloud compute instances describe "<INSTANCE_NAME>" --zone "<ZONE>" \
  --project vatedge-prod \
  --format="value(metadata.items.filter(key:enable-oslogin).extract(value))"
gcloud compute project-info describe --project vatedge-prod \
  --format="value(commonInstanceMetadata.items.filter(key:enable-oslogin).extract(value))"
```

### 1. Branch consolidation is correct

```bash
# Confirm fork-strip is a clean fast-forward over main (expect: 0 left, 5 right) BEFORE FF
git fetch origin
git rev-list --left-right --count origin/main...origin/fork-strip

# After FF: main and fork-strip point at the same commit
git rev-parse origin/main origin/fork-strip   # two identical SHAs
```

### 2. WIF + IAP auth works from a GitHub Action (smoke)

Add a temporary `workflow_dispatch` job (or run locally with the SA) that does only:

```bash
gcloud auth list                     # confirms the federated identity is active
gcloud compute instances describe "<INSTANCE_NAME>" --zone "<ZONE>" \
  --project vatedge-prod --format="value(status)"   # proves compute.viewer + project access
```

### 3. IAP SSH connectivity (no deploy yet)

```bash
gcloud compute ssh "<SSH_TARGET>@<INSTANCE_NAME>" \
  --project vatedge-prod --zone "<ZONE>" --tunnel-through-iap \
  --command 'echo ssh-ok && whoami && pwd'
# Expect: ssh-ok, the SSH user, and a home dir. Proves iap.tunnelResourceAccessor + SSH access.
```

### 4. Passwordless restart is in place (the sudo fix)

```bash
gcloud compute ssh "<SSH_TARGET>@<INSTANCE_NAME>" \
  --project vatedge-prod --zone "<ZONE>" --tunnel-through-iap \
  --command 'sudo -n systemctl restart dev-agent && systemctl is-active dev-agent'
# Expect: "active". The -n flag fails loudly if sudo would prompt → proves the sudoers drop-in.
```

### 5. Manual deploy dry-run (the script end-to-end, before wiring the Action)

```bash
gcloud compute ssh "<SSH_TARGET>@<INSTANCE_NAME>" \
  --project vatedge-prod --zone "<ZONE>" --tunnel-through-iap \
  --command 'REPO_BRANCH=main bash /opt/vatedge-dev-agent/deploy/deploy.sh'
# Expect: log lines through "dev-agent is active". Non-zero exit = failure surfaced.

# Independently confirm the service and the deployed commit:
gcloud compute ssh "<SSH_TARGET>@<INSTANCE_NAME>" \
  --project vatedge-prod --zone "<ZONE>" --tunnel-through-iap \
  --command 'systemctl is-active dev-agent && git -C /opt/vatedge-dev-agent rev-parse HEAD'
# The HEAD SHA must equal origin/main's SHA.
```

### 5b. Group-config reconcile (X) — bootstrap + idempotency

```bash
# Bootstrap: export the live prod DB into groups.config.json (run on the VM), then
# pull the file into the repo and commit it as the desired-state seed.
gcloud compute ssh "<SSH_TARGET>@<INSTANCE_NAME>" \
  --project vatedge-prod --zone "<ZONE>" --tunnel-through-iap \
  --command 'cd /opt/vatedge-dev-agent && pnpm exec tsx scripts/reconcile-container-configs.ts export'

# Idempotency: immediately after a faithful export, a dry-run apply must show ZERO diffs.
gcloud compute ssh "<SSH_TARGET>@<INSTANCE_NAME>" \
  --project vatedge-prod --zone "<ZONE>" --tunnel-through-iap \
  --command 'cd /opt/vatedge-dev-agent && pnpm exec tsx scripts/reconcile-container-configs.ts apply --dry-run'
# Expect: "no changes" for every group.

# Change-detection: edit one field in groups.config.json (e.g. main.model), dry-run again,
# confirm exactly that one field shows in the diff and nothing else.

# Safety: confirm a folder not present in the file is reported as "left untouched", and a
# bogus folder in the file is a no-op warning (no group created). tasks/ + CLAUDE.local.md
# mtimes must be unchanged after an apply.
```

Local (no prod) sanity check against the dev DB — read-only:

```bash
# From the repo with a local data/v2.db present:
pnpm exec tsx scripts/reconcile-container-configs.ts apply --dry-run
```

### 6. Full end-to-end (the real test)

```bash
# 1) Land a trivial no-op commit on main (e.g. a docs/comment change) via PR so CI runs.
# 2) Watch CI then the deploy fire:
gh run list --branch main --limit 5
gh run watch <deploy-run-id>          # follow the deploy workflow to green

# 3) Confirm the VM now serves the new commit:
gcloud compute ssh "<SSH_TARGET>@<INSTANCE_NAME>" \
  --project vatedge-prod --zone "<ZONE>" --tunnel-through-iap \
  --command 'git -C /opt/vatedge-dev-agent rev-parse HEAD && systemctl is-active dev-agent'
# HEAD must match the just-merged commit; service "active".
```

### 7. Negative / safety checks

- **CI-red blocks deploy:** push a commit that fails typecheck on a branch, open a PR,
  confirm CI is red and (after a forced merge attempt) deploy does **not** run — the
  `workflow_run` `conclusion == 'success'` guard holds.
- **Concurrency:** trigger two pushes in quick succession; confirm the second deploy
  queues behind the first (`concurrency: deploy-prod`) rather than running concurrently.
- **Failure surfaces red:** temporarily point `REPO_BRANCH` at a branch whose build
  fails; confirm `deploy.sh` exits non-zero and the Action goes red (then revert).

## Operational values to confirm during planning

| Value | How to resolve |
|---|---|
| `<INSTANCE_NAME>`, `<ZONE>` | Test step 0, first command |
| `<SSH_TARGET>` (OS Login login name vs `devagent`) | Test step 0, second command |
| WIF pool/provider names + deploy SA email | Create during implementation; bind to this repo |

## Open risks

- Retiring `fork-strip` means `main` no longer mirrors upstream `nanocoai/nanoclaw`;
  future upstream merges become a manual rebase/merge into the diverged `main`. Accepted —
  upstream sync is rare and the fork is already heavily diverged.
- The sudoers drop-in widens what the SSH user can do as root by exactly one command;
  scoped to `systemctl restart dev-agent` to keep blast radius minimal.
