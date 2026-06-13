#!/usr/bin/env bash
#
# Provision the wake-on-message infra for the dev-agent VM and deploy the
# slack-gateway Cloud Function. Idempotent — safe to re-run.
#
# Creates:
#   - Pub/Sub topic + pull subscription (durable buffer for Slack events)
#   - IAM: gateway SA → publish + start VM ; VM SA → subscribe + stop self
#   - the slack-gateway 2nd-gen Cloud Function (HTTP, public, Slack-signed)
#
# Prereqs: gcloud authenticated with rights to manage Pub/Sub, IAM, Cloud
# Functions in the project; the Slack signing secret already in Secret Manager.
#
# Fill these in (or pass as env) before running:
set -euo pipefail

PROJECT="${PROJECT:-vatedge-prod}"
REGION="${REGION:-europe-west1}"

# --- the dev-agent VM (the thing we wake/sleep) ---
VM_NAME="${VM_NAME:?set VM_NAME to the dev-agent instance name}"
VM_ZONE="${VM_ZONE:?set VM_ZONE, e.g. europe-west1-b}"
VM_SA="${VM_SA:-dev-agent@${PROJECT}.iam.gserviceaccount.com}"

# --- Pub/Sub ---
TOPIC="${TOPIC:-dev-agent-slack-events}"
SUBSCRIPTION="${SUBSCRIPTION:-dev-agent-slack-events-sub}"

# --- Function ---
FUNCTION="${FUNCTION:-slack-gateway}"
GATEWAY_SA="${GATEWAY_SA:-slack-gateway@${PROJECT}.iam.gserviceaccount.com}"
SIGNING_SECRET_NAME="${SIGNING_SECRET_NAME:-dev-agent-slack_signing_secret}"
SOURCE_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "== Project ${PROJECT} / region ${REGION} =="

echo "== 1. Pub/Sub topic + subscription =="
gcloud pubsub topics create "${TOPIC}" --project "${PROJECT}" 2>/dev/null || echo "  topic exists"
# Long ack deadline so a slow agent run never auto-nacks; retain a week so a
# message survives a long VM downtime.
gcloud pubsub subscriptions create "${SUBSCRIPTION}" \
  --project "${PROJECT}" --topic "${TOPIC}" \
  --ack-deadline=600 --message-retention-duration=7d 2>/dev/null || echo "  subscription exists"

echo "== 2. Gateway service account =="
gcloud iam service-accounts create "${GATEWAY_SA%%@*}" \
  --project "${PROJECT}" --display-name "slack-gateway function" 2>/dev/null || echo "  SA exists"

echo "== 3. IAM: gateway SA → publish to topic =="
gcloud pubsub topics add-iam-policy-binding "${TOPIC}" --project "${PROJECT}" \
  --member "serviceAccount:${GATEWAY_SA}" --role roles/pubsub.publisher

echo "== 4. IAM: VM SA → subscribe to subscription =="
gcloud pubsub subscriptions add-iam-policy-binding "${SUBSCRIPTION}" --project "${PROJECT}" \
  --member "serviceAccount:${VM_SA}" --role roles/pubsub.subscriber

echo "== 5. IAM: gateway SA → start VM ; VM SA → stop self =="
# compute.instanceAdmin.v1 at the instance level grants start/stop on just this
# instance (no project-wide compute power).
gcloud compute instances add-iam-policy-binding "${VM_NAME}" \
  --project "${PROJECT}" --zone "${VM_ZONE}" \
  --member "serviceAccount:${GATEWAY_SA}" --role roles/compute.instanceAdmin.v1
gcloud compute instances add-iam-policy-binding "${VM_NAME}" \
  --project "${PROJECT}" --zone "${VM_ZONE}" \
  --member "serviceAccount:${VM_SA}" --role roles/compute.instanceAdmin.v1

echo "== 6. IAM: gateway SA → read the signing secret =="
gcloud secrets add-iam-policy-binding "${SIGNING_SECRET_NAME}" --project "${PROJECT}" \
  --member "serviceAccount:${GATEWAY_SA}" --role roles/secretmanager.secretAccessor

echo "== 7. Deploy the slack-gateway function (2nd gen, public) =="
gcloud functions deploy "${FUNCTION}" \
  --project "${PROJECT}" --region "${REGION}" --gen2 \
  --runtime nodejs20 --source "${SOURCE_DIR}" --entry-point slackGateway \
  --trigger-http --allow-unauthenticated \
  --memory 512Mi \
  --service-account "${GATEWAY_SA}" \
  --set-env-vars "PUBSUB_TOPIC=${TOPIC},VM_PROJECT=${PROJECT},VM_ZONE=${VM_ZONE},VM_NAME=${VM_NAME}" \
  --set-secrets "SLACK_SIGNING_SECRET=${SIGNING_SECRET_NAME}:latest"

echo
echo "== DONE =="
echo "Function URL (set this as the Slack Request URL + Interactivity Request URL):"
gcloud functions describe "${FUNCTION}" --project "${PROJECT}" --region "${REGION}" \
  --gen2 --format 'value(serviceConfig.uri)'
echo
echo "Next: on the VM set SLACK_GATEWAY_SUBSCRIPTION=${SUBSCRIPTION} and IDLE_STOP_MINUTES=30,"
echo "remove SLACK_APP_TOKEN, then reconfigure the Slack app (see deploy/slack-gateway/README.md)."
