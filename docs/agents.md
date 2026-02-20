# Repository Guidelines

## Product Docs

- Read `PRODUCT_DESIGN.md` for product decisions, UX flows, and the WhatsApp one-click web app vision.
- Read `PRODUCT_TECH_SPEC.md` for the technical architecture, API contracts, and deployment model.
- Read `OPENCLAW_CONFIG_REFERENCE.md` for all openclaw gateway configuration options (channels, agents, models, tools, plugins, etc.).
- If product decisions conflict with these docs, ask for clarification before proceeding.

## Project Structure

- Deploy service: `src/deploy/` — Express API server, QR login worker, Docker provisioner, PostgreSQL store.
- Static UI: `src/deploy/public/` — login page, admin dashboard.
- Migrations: `src/deploy/migrations/` — PostgreSQL schema migrations (run automatically on startup).
- Gateway image: built from `Dockerfile.gateway` (build context is repo root, includes `openclaw/` submodule).
- Docker Compose: `docker-compose.yml` — `db` (Postgres), `deploy` (API server), `gateway-image` (build-only helper).
- Config: `.env.example` — copy to `.env` and set provider API keys.

## Submodule Policy

- `openclaw/` is a git submodule (`https://github.com/openclaw/openclaw.git`). **NEVER** modify files inside it directly.
- If changes are absolutely necessary, create git patch files in `patches/` (top-level, outside the submodule) and apply them in `Dockerfile.gateway` on top of the original source.
- Never stage the submodule pointer unless intentionally updating to a new upstream commit.

## Architecture Overview

- **Multi-user, one gateway per user**: each user gets their own Docker container running an openclaw gateway.
- **Provisioner** (`src/deploy/provisioner-docker.ts`): idempotent container lifecycle — provision, deprovision, restart, health check, startup reconciliation. Docker is the source of truth for container status.
- **Store** (`src/deploy/store-postgres.ts`, `src/deploy/store-memory.ts`): PostgreSQL (production) or in-memory (dev fallback). Tracks users, agents, login sessions, and gateway instances.
- **Login flow**: QR code → WhatsApp link → WA session stored in temp dir → moved to user's permanent auth dir → gateway provisioned.
- **Admin**: `/admin` dashboard and `/v1/admin/*` API endpoints (protected by `OPENCLAW_DEPLOY_ADMIN_TOKEN`).

## Dev Basics

- Node >= 22, pnpm
- Start locally: `docker compose up` (builds gateway image, starts Postgres + deploy server)
- Dev server (without Docker): `node --import tsx src/deploy/server.ts`
