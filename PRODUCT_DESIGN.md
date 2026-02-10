# Product Design: One-Click WhatsApp Agent Web App

Status: Draft
Last updated: 2026-02-07

## Summary

Build a web app that lets non-technical users deploy a personal AI agent on WhatsApp with one click plus a QR scan. The QR scan doubles as login and as the WhatsApp channel link. Hosting is fully managed.

## Goals

- Enable a user to go from landing page to a working WhatsApp agent in under 60 seconds.
- Keep onboarding to a single primary action and a QR scan.
- Make the agent private by default by only allowing messages from the logged in WhatsApp number.
- Provide a simple post-deploy customization screen for name, tone, and model.

## Non-Goals

- Multi-channel setup in the initial onboarding flow.
- Bring-your-own-cloud or self-hosting options.
- Advanced bot management or team features.
- Pre-deploy model selection or complex setup wizards.

## Target Audience

Non-technical individuals who want a personal AI agent inside WhatsApp without dealing with servers, bots, or tokens.

## Value Proposition

Deploy your personal AI agent on WhatsApp in one click. One scan. You are live.

## Core Product Decisions

- Primary channel is WhatsApp.
- Authentication is WhatsApp Web QR pairing and doubles as account creation.
- Default model is chosen by the product and not shown during onboarding.
- Personal WhatsApp number is the default.
- Managed hosting only.
- Optional customization is shown only after the agent is already running.

## Primary Flow

1. Landing page with one primary CTA, "Connect WhatsApp".
2. QR screen that instructs the user to scan from WhatsApp Linked Devices.
3. Deploying screen while the agent is provisioned and the WhatsApp session is linked.
4. Success screen with "Open WhatsApp" and a suggested first message.
5. Optional "Customize your agent" screen.

## Screen Copy and Structure

Landing
Title: Deploy your personal AI agent on WhatsApp.
Subhead: One click. One scan. You are live.
Primary CTA: Connect WhatsApp
Secondary CTA: See how it works

How it works
Step 1: Connect WhatsApp. Scan the QR from Linked Devices.
Step 2: We deploy your agent. Usually ready in about a minute.
Step 3: Start chatting. Open WhatsApp and say hello.

Pairing
Title: Scan to connect
Body: Open WhatsApp, go to Linked Devices, and scan this QR.
Footnote: This creates your account and links your agent.

Deploying
Title: Deploying your agent
Body: This takes about 30 to 60 seconds.
Microcopy: We will open WhatsApp when it is ready.

Success
Title: You are live on WhatsApp
Primary CTA: Open WhatsApp
Helper copy: Try: Summarize my last 10 messages.
Secondary action: Customize your agent

Customize
Title: Customize your agent
Subtitle: Optional. Your agent is already live.
Fields: Agent name, Tone, Model, Language, Who can chat
Primary CTA: Save changes
Secondary action: Skip for now

## Defaults and Configuration

- Default model: Best overall balance of quality, latency, and cost.
- Default tone: Clear and concise.
- Default language: Auto detect.
- Who can chat: Only the logged in number is allowlisted.
- DM policy: Allowlist by default. Pairing can be enabled later in settings.
- Self-chat mode: Enabled if using personal number.

## Model Tiers

- Best overall (default): OpenAI flagship tier, mapped to the latest stable model ID in server config.
- Fast and affordable: Google Gemini Flash tier, mapped to the latest stable model ID in server config.
- Premium reasoning: Anthropic Claude Opus tier, mapped to the latest stable model ID in server config.
- UI labels should be provider-agnostic while the settings page shows provider and tier.

## Pricing and Plans

- Keep onboarding ungated. Do not require plan selection before the QR scan.
- Show a simple "Free to start" line on the landing page.
- Provide a Pricing link in the header and footer.
- Prompt for billing only after deploy, or when a user hits limits.

## Default Limits

- Message volume: 500 total messages per day (inbound + outbound).
- History retention: 30 days of message context.
- Media storage: 1 GB, retained for 14 days, oldest-first cleanup.
- Over-limit behavior: pause responses and show a clear upgrade prompt.

## Identity and Account Model

- A user account is created after a successful WhatsApp QR scan.
- The WhatsApp account identifier becomes the primary user identity.
- A user has exactly one default agent at creation time.

## Deployment Model

- A managed OpenClaw gateway instance is created per user.
- WhatsApp credentials are stored and managed server side.
- The gateway starts with a minimal config focused on a single WhatsApp account.

## Error and Edge Cases

- QR expired. Show a refresh action that regenerates a new QR.
- Session invalidated. Show a reconnect flow that returns to the QR screen.
- Deploy timeout. Provide a retry action and a status indicator.
- WhatsApp number not available. Provide guidance and an option to switch to a spare number later.

## Security and Privacy

- Only the logged in WhatsApp number is allowed to send messages by default.
- Do not message any contacts automatically.
- Store WhatsApp session data securely and rotate if compromised.
- Provide a clear disconnect option that logs out the WhatsApp session.

## Metrics

- Time from landing to first successful message.
- QR scan success rate.
- Deploy success rate.
- Reconnect rate and reasons.
- Retention at day 1 and day 7.

## Future Extensions

- Add optional model selection during onboarding.
- Add other login methods and channels after WhatsApp is stable.
- Support a dedicated number flow and multi-user allowlists.
- Add billing and plan selection.

## Open Questions

- None for MVP. Revisit limits and pricing once real usage data is available.
