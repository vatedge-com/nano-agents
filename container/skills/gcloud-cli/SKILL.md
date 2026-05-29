---
name: gcloud-cli
description: Query GCP resources (Cloud Run services, logs, PubSub, GCS, IAM) on the VatEdge prod and staging projects. Use whenever the user asks about deployment state, recent errors, log searches, or production behavior. Read-only on prod (the VM's own identity); editor on staging via impersonation.
---

# gcloud — VatEdge prod + staging

This agent runs on a GCE VM whose attached service account is `dev-agent@vatedge-prod`. gcloud picks up those credentials automatically from the instance metadata server — **there is no key file and no `gcloud auth` step needed**. Just run commands.

Verify your identity any time with:

```bash
gcloud auth list   # active account should be dev-agent@vatedge-prod.iam.gserviceaccount.com
```

## Projects + permissions

| Project | Access | How |
|---|---|---|
| `vatedge-prod` | **roles/viewer + logging.viewer + monitoring.viewer** — read-only | Direct: `gcloud <cmd> --project=vatedge-prod` (you already ARE the prod read-only SA — no impersonation needed) |
| `vatedge-staging` | **roles/editor** — read+write Cloud Run, GCS, PubSub, Workflows, Logs, etc. (no IAM/billing) | **Impersonate for writes**: `gcloud <cmd> --project=vatedge-staging --impersonate-service-account=dev-agent@vatedge-staging.iam.gserviceaccount.com` |

The prod identity also has `viewer` on staging, so read-only staging queries work without impersonation. You only need `--impersonate-service-account=dev-agent@vatedge-staging…` for staging **writes** (deploys, GCS uploads, PubSub publishes, etc.). The prod SA has been granted `serviceAccountTokenCreator` on the staging SA, which is what makes the impersonation work.

## Region

All VatEdge Cloud Run services + Workflows live in `europe-west1`. Always pass `--region=europe-west1` to Cloud Run commands.

## Common one-liners

```bash
# List Cloud Run services on prod (read-only, direct)
gcloud run services list --project=vatedge-prod --region=europe-west1

# Read the last 50 ERROR entries of the prod backend log
gcloud logging read \
  'resource.type=cloud_run_revision AND resource.labels.service_name=vatedge-backend AND severity>=ERROR' \
  --project=vatedge-prod --limit=50 --format=json

# Describe a service on staging (read — direct works too)
gcloud run services describe dataflow-cr --project=vatedge-staging --region=europe-west1

# WRITE on staging (editor) — impersonate the staging SA
gcloud run deploy dataflow-cr --project=vatedge-staging --region=europe-west1 \
  --image=<...> \
  --impersonate-service-account=dev-agent@vatedge-staging.iam.gserviceaccount.com

# List PubSub subscriptions on prod (read-only, direct)
gcloud pubsub subscriptions list --project=vatedge-prod
```

## Hard rules

- NEVER attempt write operations on `vatedge-prod`. The VM's identity is read-only there by IAM — writes fail with `PERMISSION_DENIED`. If a user asks for a destructive prod change, refuse and escalate to a human.
- For staging WRITES, always pass `--impersonate-service-account=dev-agent@vatedge-staging.iam.gserviceaccount.com`. Without it you act as the prod read-only SA and the write fails.
- NEVER create or delete service accounts, modify IAM bindings, or touch billing — even on staging (those are excluded from `roles/editor`).
- ALWAYS pass `--project=...` explicitly; do not rely on the gcloud config default.
- Quote log filters tightly. A broad `severity>=DEFAULT` on a busy service returns thousands of lines and burns the context window. Default to `severity>=ERROR` and a small `--limit` (10-50). Use `--freshness=1h` if the user asks about "recent."
