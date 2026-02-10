# Repository Guidelines

## Product Design

- Read `PRODUCT_DESIGN.md` before making product decisions or implementing the WhatsApp one-click web app.
- If product decisions conflict with the design doc, ask for clarification before proceeding.

## Project Structure

- Deploy service: `src/deploy/` (API + QR login worker + provisioning stubs).
- Static UI: `src/deploy/public/`.
- Docs: `PRODUCT_DESIGN.md`, `PRODUCT_TECH_SPEC.md`.
- OpenClaw source is a submodule in `openclaw/`. Do not modify it unless explicitly asked.

## Dev Basics

- Node >= 22
- Start dev server: `node --import tsx src/deploy/server.ts`
