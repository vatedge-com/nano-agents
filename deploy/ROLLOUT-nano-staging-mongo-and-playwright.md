# Rollout: staging Mongo + Playwright for Nano (`cli-with-rotem`)

Staged runbook for two capability additions to the `cli-with-rotem` agent group
(Nano). **Nothing here is auto-applied.** Run the steps when ready.

- **Agent group id:** `ag-1779860326306-rzic49`
- **VM:** `dev-agent`, zone `europe-west1-b`, project `vatedge-prod`
- **Deploy branch:** `fork-strip` (VM does `git reset --hard origin/fork-strip`)
- **SSH:** `gcloud compute ssh dev-agent --zone=europe-west1-b`
- **`ncl` on the VM:** run as the `devagent` user against the host socket,
  e.g. `sudo -u devagent /opt/vatedge-dev-agent/... ncl ...` (use the same
  invocation the existing MCP installs used).

---

## What's already staged in the working tree (NOT committed/pushed/deployed)

| File | Change | For |
|------|--------|-----|
| `src/secrets/scoped-secrets.ts` | Added `MONGODB_STAGING_URL` to `ScopedSecrets`, `KNOWN_KEYS`, `GCP_SECRET_KEYS` | Mongo |
| `src/container-runner.ts` | Added `MONGODB_STAGING_URL` to `CONTAINER_SECRET_KEYS` | Mongo |
| `container/skills/frontend-engineer/SKILL.md` | Replaced dead `agent-browser` calls with Playwright MCP tools + Slack screenshot workflow | Playwright |

Host builds clean (`pnpm run build`) and all 342 host tests pass.

These reach the VM only via: commit → push to `origin/fork-strip` → `deploy.sh`.
Per workspace rules, **commit + push need explicit OK.**

---

## Part A — Staging MongoDB (read/write, like the operator has)

Full read+write via the official MongoDB MCP server, connection string sourced
from a new GCP secret (matches the existing `dev-agent-<key>` pattern).

### A1. Create the GCP secret (additive — doesn't affect the running agent)

Value = the staging `MONGODB_URL` from `dataflow/.env`. Pipe it in without
printing it to the terminal:

```bash
set -a; . /Users/rotemassa/WebstormProjects/vatedge-workspace/dataflow/.env; set +a
printf '%s' "$MONGODB_URL" | gcloud secrets create dev-agent-mongodb_staging_url \
  --project=vatedge-prod --replication-policy=automatic --data-file=-
# rotate later with: ... gcloud secrets versions add dev-agent-mongodb_staging_url --data-file=-
unset MONGODB_URL
```

### A2. Deploy the host code (picks up the new secret at startup)

```bash
# after commit + push to origin/fork-strip:
gcloud compute ssh dev-agent --zone=europe-west1-b --command \
  'sudo -u devagent REPO_BRANCH=fork-strip bash /opt/vatedge-dev-agent/deploy/deploy.sh'
```

`deploy.sh` resets to `origin/fork-strip`, builds, rebuilds the base image, and
restarts the host. On restart `prefetchScopedSecrets()` fetches
`dev-agent-mongodb_staging_url` → available as `$MONGODB_STAGING_URL`.

### A3. Wire the MCP server into the group (DB-backed config)

```bash
ncl groups config add-mcp-server --id ag-1779860326306-rzic49 \
  --name mongodb \
  --command npx \
  --args '["-y","mongodb-mcp-server@latest"]' \
  --env '{"MDB_MCP_CONNECTION_STRING":"$MONGODB_STAGING_URL","MDB_MCP_READ_ONLY":"false","MDB_MCP_TELEMETRY":"disabled"}'
```

The container substitutes `$MONGODB_STAGING_URL` from its injected env
(`CONTAINER_SECRET_KEYS`) at spawn — the literal credential never lands in
`container.json`.

### A4. Restart the group container (no rebuild needed for MCP-only change)

```bash
ncl groups restart --id ag-1779860326306-rzic49
```

### A5. Verify

Ask Nano in Slack to "count documents in the staging `accounts` collection" (or
similar). Expect a real number. Full read+write is enabled (insert/update/delete/
drop all allowed) — staging only.

---

## Part B — Playwright (self-check UI + screenshot client-facing changes)

Scoped to Nano's per-group image only (Chromium via per-group apt package), so
the shared base image stays slim.

### B1. Add Chromium as a per-group apt package

```bash
ncl groups config add-package --id ag-1779860326306-rzic49 --apt chromium
```

### B2. Wire the Playwright MCP server, pointed at system Chromium

```bash
ncl groups config add-mcp-server --id ag-1779860326306-rzic49 \
  --name playwright \
  --command npx \
  --args '["-y","@playwright/mcp@latest","--headless","--no-sandbox","--executable-path","/usr/bin/chromium","--output-dir","/workspace/agent/screenshots"]' \
  --env '{}'
```

`--no-sandbox` is required (container runs as non-root `node` with no sandbox
privileges). Screenshots land in `/workspace/agent/screenshots/`, readable by
`send_file` (relative path `screenshots/<name>.png`).

### B3. Rebuild the per-group image + restart (required for the apt package)

```bash
ncl groups restart --id ag-1779860326306-rzic49 --rebuild
```

> The `frontend-engineer` SKILL.md update (Playwright tools + the "client-facing
> change → screenshot → send_file to Slack" step) ships via the same
> commit/push/deploy as Part A's code changes.

### B4. Verify

Ask Nano to start the vatedge frontend dev server, navigate to a page, take a
screenshot, and `send_file` it to the Slack thread. Confirm the PNG appears in
Slack.

---

## Part C — Watch #deploys, alert the initiator on a `dev` deploy

Goal: when a **branch `dev`** deploy (→ staging) posts to #deploys, Nano wakes
**without** an @-mention, finds the developer who initiated the change, and pings
them in-thread to go verify on staging. (UI/Playwright checks are Nano's *pre-merge*
discipline — not part of this reaction.) Skill: `container/skills/dev-deploy-alert/`.

### C0. ⚠️ Human prerequisite — invite the bot to #deploys

In Slack, in **#deploys**, run `/invite @Nano` (the bot is `is_member:false` today,
so it receives nothing until invited). Channel id: `C0B1FKC0SRJ`.

### C1. Register #deploys as a messaging group

`unknown_sender_policy=public` so Cloud Build's **bot/webhook** posts aren't dropped
(`strict` drops unknown senders; `request_approval` would gate every deploy).

```bash
ncl messaging-groups create \
  --channel_type slack \
  --platform_id C0B1FKC0SRJ \
  --name deploys \
  --is_group 1 \
  --unknown_sender_policy public
# note the returned messaging_group_id (MG_ID) for C2
```

### C2. Wire #deploys → Nano with pattern engage (no @-mention needed)

```bash
ncl wirings create \
  --messaging_group_id <MG_ID> \
  --agent_group_id ag-1779860326306-rzic49 \
  --engage_mode pattern \
  --engage_pattern '<DEV_DEPLOY_REGEX>' \
  --sender_scope all \
  --ignored_message_policy accumulate \
  --session_mode per-thread
```

> **`<DEV_DEPLOY_REGEX>` is TBD until we see a real message.** The bot can't read
> #deploys history yet (not_in_channel), so the exact deploy-message text/branch
> field is unknown. After C0, capture one real `dev` deploy message and set a regex
> that matches a deploy notification **and** branch `dev`, e.g. (case-insensitive)
> something like `(?i)deploy.*branch[:\s\x60]*dev\b` — **tighten against the actual
> format**. Keep it `dev`-specific so Nano doesn't wake on every `main` deploy. The
> `dev-deploy-alert` skill also filters branch=`dev` defensively, so an over-broad
> regex is safe-but-wasteful, never wrong.

### C3. Skill ships via the same deploy

`container/skills/dev-deploy-alert/SKILL.md` reaches the VM through commit → push to
`origin/fork-strip` → `deploy.sh` (Part A2). No separate step.

### C4. Live validation (the only way to confirm bot-to-bot delivery)

After C0–C3 + deploy, trigger (or wait for) a real `dev` deploy and confirm Nano's
inbound DB received the bot message and he posted an in-thread alert. **Risk:** if
Slack doesn't deliver the notifier's bot/app message to Nano's app (depends on the
notifier posting method + the app's `message.channels` subscription), the wiring
never fires — at that point the notifier must be adjusted to @-mention, or post via a
method the bot can see. Validate before declaring done.

## Already working — no action needed

**Slack pictures (read + send) are fully wired today:**

- **Reading:** `@chat-adapter/slack` captures `event.files` → `chat-sdk-bridge.ts`
  downloads + base64-inlines each attachment → `formatter.ts` writes it to
  `/workspace/agent/attachments/<seq>/` and hands images to Claude's `Read` tool
  as vision input.
- **Sending:** `send_file` MCP tool → outbox → `delivery.ts` → Slack upload via
  `adapter.postMessage(..., { files })`.

---

## Rollback

- **Mongo MCP:** `ncl groups config remove-mcp-server --id ag-1779860326306-rzic49 --name mongodb` + restart. Optionally `gcloud secrets delete dev-agent-mongodb_staging_url`. Revert the two host code edits.
- **Playwright:** `ncl groups config remove-mcp-server --id ag-1779860326306-rzic49 --name playwright`; remove the apt package (edit config) + `--rebuild` restart.
