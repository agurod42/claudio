# Product Tech Spec: One-Click WhatsApp Agent Web App

Status: Draft
Last updated: 2026-02-07

## Scope

This spec describes the minimum technical design needed to implement the product described in `PRODUCT_DESIGN.md`. It focuses on the WhatsApp-first onboarding flow, a managed gateway per user, and a minimal settings surface.

## Goals

- One-click onboarding with a WhatsApp QR scan.
- Managed hosting, no BYO keys.
- Per-user isolation with a dedicated gateway container.
- Simple post-deploy customization.
- Clear reconnection flow.

## Non-Goals

- Multi-channel onboarding.
- BYO cloud or self-hosting.
- Team or multi-user sharing.
- Pre-deploy model selection.

## Architecture Summary

Components:
- Web app: landing + onboarding + settings UI.
- API service: session creation, streaming updates, provisioning, settings updates.
- QR/login worker: creates a Baileys socket and emits QR updates.
- Provisioner: starts a gateway container per user.
- Gateway containers: run OpenClaw with WhatsApp Web sessions.
- Postgres: users, sessions, settings, usage.
- Shared volume: WhatsApp creds per user.
- Observability: logs, metrics, alerts.

Key constraints from OpenClaw:
- WhatsApp login is QR-based and stores credentials on disk.
- QR can be emitted programmatically via `createWaSocket` `onQr`.
- The gateway reads WhatsApp creds from a local directory.

## Data Flow

1. User clicks "Connect WhatsApp".
2. API creates a login session and starts a QR worker.
3. QR worker emits QR updates over SSE.
4. User scans QR in WhatsApp.
5. QR worker detects connection open and writes creds to the shared volume.
6. API provisions a gateway container with the creds path mounted.
7. API streams "ready" and shows success UI.

## API Surface

All responses are JSON unless noted. The API is versioned under `/v1`.

### POST /v1/login-sessions

Creates a login session and starts QR generation.

Response:
```json
{
  "sessionId": "ls_123",
  "streamUrl": "/v1/login-sessions/ls_123/stream",
  "expiresAt": "2026-02-07T18:20:00.000Z"
}
```

### GET /v1/login-sessions/:id/stream (SSE)

Server-Sent Events stream for QR and status updates.

Events:
- `qr` payload `{ "qr": "raw-qr-string", "expiresAt": "..." }`
- `status` payload `{ "state": "waiting|scanned|linked|deploying|ready|error", "message": "..." }`
- `error` payload `{ "code": "SESSION_EXPIRED|LOGIN_FAILED|PROVISION_FAILED", "message": "..." }`
- `auth` payload `{ "token": "<bearer>", "expiresAt": "..." }` (emitted after `ready`)

### GET /v1/me

Returns the authenticated user.

Auth
- API requests to `/v1/me`, `/v1/agent`, and `/v1/agent` updates require `Authorization: Bearer <token>`.
- Token is issued over SSE after the WhatsApp session is ready.

### GET /v1/agent

Returns the agent status and settings.

Response:
```json
{
  "agentId": "ag_123",
  "status": "running",
  "modelTier": "best",
  "name": "Claw",
  "tone": "clear",
  "language": "auto",
  "allowlistOnly": true
}
```

### PATCH /v1/agent

Updates settings.

Request:
```json
{
  "name": "Claw",
  "tone": "clear",
  "modelTier": "best",
  "language": "auto",
  "allowlistOnly": true
}
```

### POST /v1/agent/reconnect

Starts a new login session tied to the user and returns a new stream URL.

## Session State Machine

States:
- `waiting`: QR generated, waiting for scan.
- `scanned`: QR scanned, connection not open yet.
- `linked`: WhatsApp session open, creds saved.
- `deploying`: gateway container provisioning started.
- `ready`: gateway running and healthy.
- `error`: terminal error state.
- `expired`: QR expired or session timeout.

Transitions:
- `waiting` -> `scanned` when QR is scanned.
- `scanned` -> `linked` when connection opens.
- `linked` -> `deploying` when provisioning starts.
- `deploying` -> `ready` on healthy gateway.
- Any -> `error` on failure.
- `waiting` -> `expired` on timeout.

## Database Schema

`users`
- `id` (pk)
- `whatsapp_id` (unique)
- `created_at`
- `status` (active|pending|disconnected)

`agents`
- `id` (pk)
- `user_id` (fk)
- `gateway_instance_id`
- `model_tier` (best|fast|premium)
- `name`
- `tone`
- `language`
- `allowlist_only` (bool)
- `created_at`

`login_sessions`
- `id` (pk)
- `user_id` (nullable until linked)
- `state` (waiting|scanned|linked|deploying|ready|error|expired)
- `error_code`
- `expires_at`
- `created_at`

`gateway_instances`
- `id` (pk)
- `user_id` (fk)
- `container_id`
- `status` (provisioning|running|stopped|error)
- `auth_dir_path`
- `created_at`

`usage_daily`
- `id` (pk)
- `user_id` (fk)
- `date`
- `messages_count`
- `media_bytes`

## Provisioning

Inputs:
- `auth_dir_path` on shared volume.
- Initial config template with WhatsApp allowlist.
- Model tier default set to `best`.

Steps:
- Create a `gateway_instances` record.
- Start a container with the shared volume mounted.
- Write config pointing to the WhatsApp auth dir.
- Start gateway.
- Probe health and update status to `running`.

Local Docker provisioner:
- Set `OPENCLAW_DEPLOY_PROVISIONER=docker`.
- Set `OPENCLAW_DEPLOY_DOCKER_IMAGE` to a locally built OpenClaw image.
- Container mounts `auth_dir_path` to `/data/auth` and sets `OPENCLAW_CONFIG_PATH=/data/auth/openclaw.json`.
- A reaper job runs every `OPENCLAW_DEPLOY_REAPER_INTERVAL_MS` and removes orphaned/stale gateway containers.

## WhatsApp Credentials

- QR worker writes credentials to `auth_dir_path`.
- Gateway reads credentials from the same mounted path.
- The QR worker must run on the same host or volume that the gateway uses.

## Model Tiers

- `best` maps to OpenAI flagship.
- `fast` maps to Google Gemini Flash tier.
- `premium` maps to Anthropic Claude Opus tier.
- Exact model IDs are stored in config, not hard-coded.

## Limits and Enforcement

Defaults:
- 500 messages per day.
- 30 days history retention.
- 1 GB media storage with 14-day retention.

Behavior:
- On limit hit, pause responses and surface upgrade prompt.

## Security and Privacy

- Default allowlist is the logged-in WhatsApp number only.
- No automatic messaging to contacts.
- Provide explicit disconnect that logs out the WhatsApp session.
- Encrypt any stored provider keys and rotate as needed.

## Observability

Metrics:
- Time to first message.
- QR scan success rate.
- Provisioning success rate.
- Reconnect rate.
- Daily active users.

Logs:
- Login session events.
- Gateway container lifecycle.
- WhatsApp connection errors.

## Open Issues

- Hosting platform for containers and shared volume.
- Final decision on health probes for readiness.
