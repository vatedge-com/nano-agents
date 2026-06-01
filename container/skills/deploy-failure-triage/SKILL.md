---
name: deploy-failure-triage
description: Use when you are @-mentioned on a Cloud Build pipeline/deploy/CI FAILURE notification in the Slack #deploys channel (or in that message's thread). Reads the build logs, explains in the thread — shortly and plainly — what broke, then EITHER opens a fix PR (if it's a code issue you can confidently fix) OR suggests a solution and asks for instructions (if it's infra/config or you're unsure). Covers the vatedge, dataflow, and vat-agent repos on prod and staging. NOT for feature requests or product changes (that is new-feature-workflow) and NOT for general log/ops questions (that is gcloud-cli).
---

# Deploy-failure triage

A Cloud Build pipeline failed and posted to **#deploys**. A human @-mentioned you on
that message. Your job: figure out what went wrong, say so in the thread *briefly*,
and then fix it with a PR if it's code — or suggest a fix and ask, if it isn't.

You are doing **triage**, not a feature. Keep every message short. The reader is
glancing at Slack between other things.

## When to engage

Enter when **all** of these hold:
- You're @-mentioned in **#deploys** (or in the thread of a #deploys message).
- The message you're pointed at is a **Cloud Build failure** notification (status
  FAILURE / TIMEOUT / CANCELLED, ❌, "build failed", etc.).

Do **NOT** enter for:
- Feature requests, bug reports, or product changes → that's `new-feature-workflow`.
- "What's the state of prod?" / log-reading / ops questions → that's `gcloud-cli`.
- Cloud Build **success** notifications — just acknowledge briefly if asked, nothing to do.

If you're unsure which message is meant, ask one short question rather than guessing.

## Step 0 — Handshake

The instant the mention arrives, send a one-line text acknowledgment via
`send_message` (e.g. "On it — pulling the build logs now."), in the same turn,
*before* you start reading logs. Keep working and reply in that same turn — don't
end your turn on the acknowledgment, and never use a reaction in its place.

## Step 1 — Parse the failure notification

Read the Cloud Build message you were pointed at. If you were mentioned in a reply,
read the **parent** message of the thread (use the Slack tools to fetch it). The
notifier's format may change, so **parse defensively** — pull whatever of these you
can find:

- **Repository** — `vatedge`, `dataflow`, or `vat-agent`
- **Branch**
- **Commit** — short SHA (you'll branch off this)
- **Trigger** name — e.g. `vatedge-backend-trigger`, `vatedge-frontend-trigger`,
  `dataflow-trigger`. Triggers are named per **component**, NOT per environment,
  and the **same trigger name exists in both projects** — so the trigger name does
  NOT tell you prod vs staging. Use it only to map to the repo (see Step 4).
- **Project** — read it from the message's `Project:` field if present, otherwise
  from the **"View Logs" / console URL** (`…?project=<id>` query param). This is how
  you know prod vs staging.
- **Build ID** — the UUID you need for the logs
- Any **"View Logs"** / console URL (it embeds the build id, region, and project)

If you can't find a Build ID or a logs link anywhere in the message, say so in the
thread and ask the human for the build id or a logs link — don't invent one.

Determine the **project** (`vatedge-prod` or `vatedge-staging`):
- Prefer the explicit `Project:` field or the `project=` param in the logs URL.
- If neither is present, the build reads are harmless on both projects — try
  `vatedge-staging` first, then `vatedge-prod`, and use whichever returns the build.

## Step 2 — Fetch the build logs

Use the `gcloud-cli` skill. Reads need **no** impersonation on either project:

```bash
gcloud builds log <build-id> --region=europe-west1 --project=<vatedge-prod|vatedge-staging>
```

If that's noisy, also describe the build to see which **step** failed:

```bash
gcloud builds describe <build-id> --region=europe-west1 --project=<project> --format=json
```

The logs can be large — focus on the failing step's output (the tail of the failing
step, error lines, stack traces). Don't dump the whole log into the thread.

## Step 3 — Diagnose + classify

From the logs, identify the **root cause** and the **failing step + its command**,
then put the failure in exactly one bucket:

- **CODE ISSUE** — something in the repo is wrong and a code change fixes it:
  compile/type error, failing unit/integration test, lint error, broken import,
  bad migration, syntax error, dependency the code references but didn't add, etc.
  → go to Step 4 (fix path).
- **NOT A CODE ISSUE** — the code is fine; the environment isn't: quota exceeded,
  IAM/permission denied, missing secret or env var, infra/registry/network error,
  a flaky/transient failure, a base-image or external-service problem, a Cloud Build
  config (`cloudbuild.yaml`) misconfiguration that's an ops decision, etc.
  → go to Step 5 (suggest + ask).
- **NOT CONFIDENT** — the logs are ambiguous or you can't pin a single clear cause.
  → go to Step 5 (suggest + ask). **Do not** open a speculative PR.

Bias toward Step 5 when in doubt. A wrong PR costs the human more than a question.

## Step 4 — Code-fix path → open a PR

1. **Locate the repo** (`git` + `gh` are authed via `GITHUB_TOKEN`). The Cloud
   Build `Repository` field is a label, not necessarily the GitHub repo name —
   **resolve the real repo at runtime**, don't assume `<org>/<field>` exists. If
   there's no `Repository` field, infer it from the trigger/component name
   (`vatedge-backend-trigger` / `vatedge-frontend-trigger` → `vatedge`;
   `dataflow-trigger` → `dataflow`):
   - `vatedge` → already cloned at `/workspace/extra/repo` (use it if present).
   - Otherwise, resolve the GitHub repo by listing the org and matching the
     repository name, then clone on demand:
     ```bash
     gh repo list vatedge-com --limit 100   # find the repo whose name matches the failure
     mkdir -p /workspace/agent/repos && cd /workspace/agent/repos
     [ -d <repo> ] || gh repo clone vatedge-com/<resolved-repo>
     cd <repo>
     ```
   - If you **cannot** resolve a GitHub repo for the failing build (e.g. the name
     doesn't exist under the org), do **not** guess — stop and go to Step 5:
     explain what failed and ask the human which repo it lives in.
   - If `/workspace/extra/repo` doesn't exist for `vatedge`, clone it the same way.
2. **Branch off the failing commit** — not off latest main:
   ```bash
   git fetch origin
   git checkout -b fix/deploy-<shortsha>-<slug> <failing-commit-sha>
   ```
   `<slug>` is a short kebab-case description of the fix.
3. **Make the minimal fix.** Match the surrounding code's style, naming, idioms.
   No drive-by refactors. If the broken area has tests, update/add them.
4. **Light verification** — re-run **only the step that failed**, using the command
   you saw in the logs (e.g. the specific test, the lint command, `tsc`/`npm run
   build`, `pytest path::test`). You only need that one step green.
   - If the failing step **can't run in-container** (it's the deploy step itself,
     needs live GCP, etc.), you cannot verify a code fix — treat this as Step 5
     (suggest + ask) instead of opening an unverified PR.
5. **Push + open a real (non-draft) PR into `main`:**
   ```bash
   git push -u origin fix/deploy-<shortsha>-<slug>
   gh pr create --base main --head fix/deploy-<shortsha>-<slug> \
     --title "<concise fix title>" \
     --body "<2-4 lines: what broke, root cause, the fix, how it was verified>"
   ```
6. **Reply in the thread — SHORTLY** (1–3 lines):
   > ❌ `<trigger>` failed: `<one-line plain-English cause>`.
   > Fix: `<one line>`. PR: `<url>`

## Step 5 — Not-code / not-confident → suggest + ask

Reply in the thread, **short**, with three things:
1. What happened — one or two plain-English sentences (e.g. "The build hit a Cloud
   Run quota limit," "VIES secret is missing in staging," "looks like a flaky test
   — it timed out fetching, not a logic error").
2. A concrete **suggested** action (the gcloud command, the secret to set, "re-run
   the build," the config line to change).
3. A direct question: **how do you want me to proceed?**

Do **not** make prod changes, do not make staging writes, and do not open a PR on
this path unless the human comes back and tells you to.

## Hard rules

- **Trigger:** only act when @-mentioned on a Cloud Build **failure** in #deploys.
- **In-thread only:** every reply goes in the failure message's thread. Never start
  a new top-level message in #deploys.
- **Brevity:** thread messages and PR bodies are short. No log dumps, no play-by-play.
- **Branch off the failing commit**, name it `fix/deploy-<shortsha>-<slug>`, PR into
  **`main`** only. Never push to `main` or `dev`, never merge, never make a draft PR.
- **Repos:** `vatedge` = `/workspace/extra/repo`; `dataflow`/`vat-agent` = clone into
  `/workspace/agent/repos/<name>`. Never touch any other repo.
- **No prod writes, ever.** Prod gcloud is read-only by IAM. Staging writes need
  impersonation and are not part of triage — escalate instead.
- **When unsure, ask.** A speculative PR is worse than one good question.
