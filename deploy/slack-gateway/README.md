# Wake-on-message dev-agent — slack-gateway

Turns the always-on dev-agent VM (~$49/mo) into a VM that **sleeps when idle and
wakes on a Slack message** (idle compute ≈ $0). Every feature — Docker sandbox,
`self-mod`, skills-as-branches, claude-mem, SQLite state — is preserved untouched,
because it is the same VM with the same persistent data disk; we only stop/start it.

## How it works

```
Slack (Events API) ──HTTPS──▶ slack-gateway Cloud Function (scale-to-zero)
                                 │ verify Slack signature; answer url_verification
                                 │ publish event → Pub/Sub topic (durable buffer)
                                 │ start VM if stopped (compute.instances.start)
                                 │ ACK 200 (< 3s)
                                 ▼
                         Pub/Sub  dev-agent-slack-events
                                 ▼ pull (outbound — VM stays private)
   dev-agent VM ── src/channels/slack-pubsub.ts → inner.handleWebhook() → routes
                 ── src/idle-stop.ts: idle IDLE_STOP_MINUTES → compute.instances.stop (self)
```

The VM never accepts inbound connections — it only *pulls* from Pub/Sub, so it keeps
no public ingress. The authoritative Slack-signature check happens at the Function;
provenance into the buffer is enforced by Pub/Sub IAM (only the gateway SA can publish).

## Deploy

1. **Slack signing secret → Secret Manager** (the Function reads it):
   ```bash
   gcloud secrets create dev-agent-slack-signing-secret --project vatedge-prod
   printf '%s' "<your slack signing secret>" | \
     gcloud secrets versions add dev-agent-slack-signing-secret --project vatedge-prod --data-file=-
   ```

2. **Provision infra + deploy the Function** (idempotent):
   ```bash
   VM_NAME=<dev-agent instance> VM_ZONE=europe-west1-b \
     bash deploy/slack-gateway/provision.sh
   ```
   Note the printed **Function URL**.

3. **Reconfigure the Slack app** (api.slack.com/apps → your app):
   - **Socket Mode** → turn **OFF**.
   - **Event Subscriptions** → enable; set **Request URL** to the Function URL
     (it must pass the `url_verification` challenge — the Function answers it).
   - Under **Subscribe to bot events**, keep the same events the bot uses today
     (e.g. `app_mention`, `message.im`, `message.channels`).
   - **Interactivity & Shortcuts** → set **Request URL** to the same Function URL
     (block actions / approvals arrive here too).
   - Reinstall the app if Slack prompts. OAuth scopes are unchanged.

4. **VM config**: ensure the service has `SLACK_GATEWAY_SUBSCRIPTION` and
   `IDLE_STOP_MINUTES` set and **`SLACK_APP_TOKEN` removed** (presence of the
   subscription already takes precedence, but removing the app token avoids
   confusion). See `deploy/dev-agent.service`. Then deploy the host code
   (build + restart) so `slack-pubsub`/`idle-stop` are live.

## Verify (end-to-end)

1. Stop the VM manually → post a Slack mention → the Function ACKs, publishes,
   starts the VM, and the agent replies (~30–90s first reply after sleeping).
2. Post 2–3 messages while stopped → all are processed once up (backlog drained).
3. After a task and `IDLE_STOP_MINUTES` idle, confirm the instance → `TERMINATED`.
4. After a sleep cycle, confirm sessions / claude-mem / a prior self-mod package
   still present (proves the data disk + rebuilt images survived stop/start).

## Rollback

Set `IDLE_STOP_MINUTES=0` (never sleeps) and/or restore `SLACK_APP_TOKEN` + clear
`SLACK_GATEWAY_SUBSCRIPTION` to fall back to Socket Mode. The Function and Pub/Sub
can be left in place harmlessly, or deleted with `gcloud functions delete slack-gateway`.
