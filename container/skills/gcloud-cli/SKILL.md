---
name: gcloud-cli
description: Query GCP resources (Cloud Run services, logs, PubSub, GCS, IAM) on the VatEdge prod and staging projects. Use whenever the user asks about deployment state, recent errors, log searches, or production behavior. Read-only on prod (always via impersonation); editor on staging.
---

# gcloud — VatEdge prod + staging

A service-account credential file is mounted at `/workspace/extra/secrets/gcp-staging.json`. The `GOOGLE_APPLICATION_CREDENTIALS` env var points there. Activate once per session, then use the projects below.

## One-time per session

```bash
gcloud auth activate-service-account --key-file="$GOOGLE_APPLICATION_CREDENTIALS"
```

That logs you in as `dev-agent@vatedge-staging.iam.gserviceaccount.com`.

## Projects + permissions

| Project | Access | How |
|---|---|---|
| `vatedge-staging` | **roles/editor** — read+write Cloud Run, GCS, PubSub, Workflows, Logs, etc. (no IAM/billing) | Direct: `gcloud <cmd> --project=vatedge-staging` |
| `vatedge-prod` | **roles/viewer + logging.viewer + monitoring.viewer** — read-only | **MUST impersonate**: `gcloud <cmd> --project=vatedge-prod --impersonate-service-account=dev-agent-readonly@vatedge-prod.iam.gserviceaccount.com` |

The prod project has an org-policy that blocks SA key creation, so impersonation is the only way in. The staging SA has been granted `serviceAccountTokenCreator` on the prod read-only SA.

## Region

All VatEdge Cloud Run services + Workflows live in `europe-west1`. Always pass `--region=europe-west1` to Cloud Run commands.

## Common one-liners

```bash
# List Cloud Run services on staging
gcloud run services list --project=vatedge-staging --region=europe-west1

# Read the last 50 entries of the prod backend log
gcloud logging read \
  'resource.type=cloud_run_revision AND resource.labels.service_name=vatedge-backend AND severity>=ERROR' \
  --project=vatedge-prod \
  --impersonate-service-account=dev-agent-readonly@vatedge-prod.iam.gserviceaccount.com \
  --limit=50 --format=json

# Describe a service revision on staging
gcloud run services describe dataflow-cr --project=vatedge-staging --region=europe-west1

# List PubSub subscriptions on prod (read-only)
gcloud pubsub subscriptions list --project=vatedge-prod \
  --impersonate-service-account=dev-agent-readonly@vatedge-prod.iam.gserviceaccount.com
```

## Hard rules

- NEVER attempt write operations on `vatedge-prod`. If a user asks you to do something destructive in prod, refuse and explain that prod is read-only via design — escalate to a human.
- NEVER create or delete service accounts, modify IAM bindings, or touch billing — even on staging. Those are excluded from `roles/editor`.
- ALWAYS pass `--project=...` explicitly; do not rely on the gcloud config default.
- ALWAYS pass `--impersonate-service-account=...` for prod commands. If you forget, you'll get cryptic permission errors.
- Quote log filters tightly. A broad `severity>=DEFAULT` on a busy service returns thousands of lines and burns the context window. Default to `severity>=ERROR` and a small `--limit` (10-50). Use `--freshness=1h` if the user is asking about "recent."
