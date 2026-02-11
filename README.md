# Clawdly Deploy

Deploy a personal OpenClaw agent on WhatsApp with one click and a QR scan.

## What This Repo Contains

- `src/deploy/` — API service + WhatsApp QR login worker + provisioning.
- `src/deploy/public/` — static onboarding UI.
- `openclaw/` — OpenClaw source as a git submodule (do not modify unless asked).
- `PRODUCT_DESIGN.md` and `PRODUCT_TECH_SPEC.md` — product and system design.

## Requirements

- Node 22+
- Docker Desktop (for local provisioning)
- Postgres (local or Docker)

## Quick Start (Local)

1. Initialize the OpenClaw submodule:
```bash
git submodule update --init --recursive
```

2. Set at least one model provider key in `.env` (example):
```bash
ANTHROPIC_API_KEY=your-key-here
```

3. Start local services (images are built automatically on first run, then reused):
```bash
docker compose up
```

4. Open `http://localhost:8080` and connect WhatsApp.

Admin dashboard:
- Open `http://localhost:8080/admin`
- If `OPENCLAW_DEPLOY_ADMIN_TOKEN` is set, enter it in the dashboard header.
- For per-user OpenClaw connect links, set `OPENCLAW_DEPLOY_DOCKER_NETWORK` to your compose network (default shown below).
- Existing gateway containers created before these settings may need re-provisioning (reconnect flow) to pick up connect-link support.

5. Stop services when done:
```bash
docker compose down
```

If you only changed deploy service code and want to avoid rebuilding OpenClaw:
```bash
docker compose build deploy
docker compose up -d
```

You will see `gateway-image` exit with code `0`; this is expected because it is a one-shot image build helper.

## Environment Variables

- `OPENCLAW_DEPLOY_DATABASE_URL` — Postgres connection string.
- `OPENCLAW_DEPLOY_PORT` — API port (default `8080`).
- `OPENCLAW_DEPLOY_BASE_URL` — base URL for stream links.
- `OPENCLAW_DEPLOY_AUTH_SECRET` — token signing secret.
- `OPENCLAW_DEPLOY_AUTH_TTL_MS` — token TTL (default 24h).
- `OPENCLAW_DEPLOY_SESSION_TTL_MS` — QR session TTL (default 10m).
- `OPENCLAW_DEPLOY_AUTH_ROOT` — local auth dir for WhatsApp creds.
- `OPENCLAW_DEPLOY_PROVISIONER` — `noop` or `docker`.
- `OPENCLAW_DEPLOY_DOCKER_IMAGE` — gateway image name.
- `OPENCLAW_DEPLOY_DOCKER_NETWORK` — Docker network (optional).
- `OPENCLAW_DEPLOY_DOCKER_AUTH_VOLUME` — shared Docker volume name used for gateway auth/config handoff.
- `OPENCLAW_DEPLOY_DOCKER_PREFIX` — container name prefix.
- `OPENCLAW_DEPLOY_DOCKER_GATEWAY_UID` — UID used by gateway container process for auth volume ownership (default `1000`).
- `OPENCLAW_DEPLOY_DOCKER_GATEWAY_GID` — GID used by gateway container process for auth volume ownership (default `1000`).
- `OPENCLAW_DEPLOY_ADMIN_TOKEN` — optional token for admin APIs/dashboard. In production, admin routes are disabled unless this is set.
- `OPENCLAW_DEPLOY_REAPER_INTERVAL_MS` — reaper interval.
- `OPENCLAW_DEPLOY_REAPER_TTL_MS` — stale container TTL.
- Provider keys (forwarded to each gateway container when set):
  - `ANTHROPIC_API_KEY`
  - `OPENAI_API_KEY`
  - `GOOGLE_API_KEY` / `GEMINI_API_KEY`
  - `OPENROUTER_API_KEY`
  - `XAI_API_KEY`
  - `GROQ_API_KEY`
  - `MISTRAL_API_KEY`
  - `TOGETHER_API_KEY`
  - `PERPLEXITY_API_KEY`
  - `CEREBRAS_API_KEY`

## Notes

- The QR login runs on the same host as the gateway so credentials are shared.
- The default policy allowlists only the logged‑in WhatsApp number.
- Docker provisioning uses `dockerode`.

## Docs

- `PRODUCT_DESIGN.md`
- `PRODUCT_TECH_SPEC.md`
