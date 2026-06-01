---
name: dev-deploy-alert
description: Use when you wake (WITHOUT being @-mentioned) to a deploy/CI notification in the Slack #deploys channel whose branch is `dev` (dev deploys to staging). Your only job is to find the developer who initiated that change and alert them in-thread that it is live on staging, so they go verify it. Branch `dev` only — silently ignore deploys from any other branch. NOT for failures you are @-mentioned on (that is deploy-failure-triage) and NOT for running UI/Playwright tests (that is pre-merge work in new-feature-workflow).
---

# Dev deploy alert

A deploy posted to **#deploys** and you woke on it via the channel watch (no
mention). Your only job: if it is a **branch `dev`** deploy (→ staging), find **who
initiated the change** and **ping them in the thread** so they go verify their work
on staging.

You do **not** review the UI, run Playwright, or read logs here. Visual/Playwright
verification is something you do *before* merging into `dev`, not in reaction to the
deploy. This skill is a notification, nothing more.

## When to engage

Engage only when **both** hold:
- The message is a **deploy / CI notification** in #deploys.
- Its **branch is `dev`**.

If the branch is anything else (`main`, a feature branch, etc.) → **do nothing** and
end the turn silently. Never post in #deploys for a non-`dev` deploy.

If a human explicitly @-mentions you on a **failure**, that is `deploy-failure-triage`
— defer to it.

## Step 1 — Parse the deploy message (defensively)

The notifier format may change, so pull whatever you can find:
- **Branch** — confirm it is `dev` (required to proceed)
- **Repository** — `vatedge`, `dataflow`, or `vat-agent`
- **Commit** — short SHA + **author**, if present
- **Status** — success / failure
- Any **commit / PR / "View Logs"** URL

If the branch is not clearly `dev`, stop. If it is `dev` but the author is not in the
message, get it from the commit (Step 2).

## Step 2 — Identify the initiator

The "user who initiated this change" is the commit author / PR merger on `dev`.
- If the message names the author, use it.
- Otherwise resolve from the commit (`vatedge` = `/workspace/extra/repo`; other repos
  clone on demand, same as `deploy-failure-triage`):
  ```bash
  git log -1 --format='%an <%ae>' <commit-sha>
  ```
  or use `gh` to read the commit / PR author.
- Map that person to a **Slack user** with the Slack tools (`slack_get_users`,
  `slack_get_user_profile`): match by **email** first, then display name. Keep the
  matched Slack user id for the mention.

## Step 3 — Alert them, in-thread, briefly

Reply **in the deploy message's thread** (never a new top-level post), tagging the
initiator. One or two lines, e.g.:

> `<@U…>` your change `<short-sha>` just deployed to **staging** (`<status>`).
> Take a look when you can: `<staging-url or commit/PR link>`

- If you **cannot** confidently map a Slack user, post the same note naming the author
  in plain text (no ping) — a wrong @-mention is worse than a name.
- Staging URLs are in the workspace `CLAUDE.md` (vatedge frontend/backend staging).
  Link the component that deployed if you know it; otherwise just say "staging".

## Hard rules

- **Branch `dev` only.** Silently ignore every other branch — no posts.
- **One alert per deploy.** If you have already posted in that deploy's thread, stop.
  Never double-ping.
- **In-thread, short.** No log dumps, no UI review, no Playwright, no play-by-play.
- **No code changes, no prod or staging writes.** This is purely a heads-up.
- **Never guess identity.** A plain-text name beats a wrong mention.
