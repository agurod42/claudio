# Auth Stack

Claudio uses **WhatsApp as the identity provider**. There are no passwords or email accounts — a user is identified by their WhatsApp phone number, proven by scanning a QR code with the WhatsApp mobile app.

---

## Components

| Component | File | Responsibility |
|---|---|---|
| Login endpoint | `src/deploy/server.ts` | Creates login sessions, serves SSE stream |
| Login worker | `src/deploy/login-worker.ts` | Runs the Baileys WA handshake, captures sync data |
| WA session | `src/deploy/wa-session.ts` | Wraps Baileys socket creation and credential I/O |
| JWT auth | `src/deploy/auth.ts` | Issues and verifies HMAC-SHA256 tokens post-login |
| Store | `src/deploy/store.ts` | Persists session state, user records, gateway instances |
| Provisioner | `src/deploy/provisioner-docker.ts` | Spins up the per-user gateway container |

---

## The Baileys WA Session

[Baileys](https://github.com/WhiskeySockets/Baileys) is a reverse-engineered Node.js client for the **WhatsApp Web WebSocket protocol** — the same protocol your browser uses at web.whatsapp.com.

When a socket is created (`createWaSocket` in `wa-session.ts`), Baileys:

1. Reads or initialises a credential store from `authDir/` on disk
2. Opens a WebSocket to WhatsApp's servers
3. If no saved credentials exist, generates a **QR token** and emits it via `connection.update`
4. After the QR is scanned, WhatsApp authenticates the session and Baileys writes credential files to `authDir/`:
   - `creds.json` — identity keys, session keys, WA user ID
   - `app-state-sync-key-*.json`, `pre-key-*.json`, `sender-key-*.json`, `session-*.json` — Signal Protocol key material

The credential files are the only thing needed to reconnect later — no QR scan required until they are deleted or the session is revoked from the phone.

---

## Login Session State Machine

A **login session** (`LoginSession`) tracks one QR scan attempt in the DB:

```
waiting → linked → deploying → ready
                             ↘ error
         (timeout / admin close) → expired
```

| State | Meaning |
|---|---|
| `waiting` | Baileys socket is open, QR has been sent to browser |
| `linked` | QR was scanned; phone number (`whatsappId`) and `userId` are known |
| `deploying` | Provisioner is creating the gateway container |
| `ready` | Gateway is healthy; JWT has been issued to the browser |
| `expired` | Session TTL elapsed (default 10 min) or closed by admin |
| `error` | Baileys error or provisioning failure |

Sessions are stored in Postgres (`login_sessions` table). Expired/error sessions older than 6 hours are purged by the reaper (`OPENCLAW_DEPLOY_REAPER_TTL_MS`).

---

## Full Login Flow

```
Browser                    Deploy Server                WhatsApp Servers
  |                              |                              |
  | POST /v1/login-sessions      |                              |
  |----------------------------->|                              |
  |  { sessionId, streamUrl }    | mkdir tmp/<sessionId>/       |
  |<-----------------------------|                              |
  |                              | createWaSocket(authDir)      |
  | GET /v1/login-sessions/      | Baileys WS open              |
  |   <id>/stream (SSE)          |----------------------------->|
  |----------------------------->|                              |
  |                              |     QR token generated       |
  |   event: qr { image, qr }   |<-----------------------------|
  |<-----------------------------|                              |
  |  [QR shown in browser]       |                              |
  |                              |                              |
  | [User scans QR on phone]     |                              |
  |----------------------------------------------------scan---->|
  |                              |     connection: "open"       |
  |                              |     creds.json written       |
  |                              |<-----------------------------|
  |                              |     contacts.set (N items)   |
  |                              |     chats.set (N items)      |
  |                              |<-----------------------------|
  |   event: status "linked"     |                              |
  |<-----------------------------|                              |
  |                              | userId = getOrCreateUser()   |
  |                              | copy tmp/ → wa-session-data/ |
  |   event: status "deploying"  |                              |
  |<-----------------------------|                              |
  |                              | synthesizeUserProfile()  ─┐  |
  |                              | provisioner.provision()   │  |
  |                              |   (parallel)              │  |
  |                              | Docker container starts   │  |
  |   event: status "ready"      |                        ←──┘  |
  |   event: auth { token }      |                              |
  |<-----------------------------|                              |
  |  [Browser stores JWT]        |                              |
```

### Key details

- **SSE stream** (`/v1/login-sessions/:id/stream`) is a long-lived HTTP connection. The browser receives QR updates, status transitions, and finally the JWT — all pushed from the server.
- **Sync data capture**: During the `waiting → linked` window, Baileys fires `contacts.set` and `chats.set` with the user's full contact list and recent chats. Login-worker captures these and stores them in the DB (`user_profile_data` table) for profile synthesis.
- **Smart sync wait** ([`login-worker.ts`](../src/deploy/login-worker.ts)): After `connection: "open"`, login-worker waits up to 15 s for both `contacts.set` and `chats.set` to arrive before proceeding. It exits early once both have fired.
- **Synthesis + provision are parallel**: Profile synthesis (LLM call) and Docker container provisioning run concurrently to cut login time.

---

## JWT Issuance

Once the session reaches `ready`, the server issues a **HS256 JWT** ([`auth.ts`](../src/deploy/auth.ts)):

```
header.payload.signature
```

Payload fields:

| Field | Value |
|---|---|
| `sub` | `userId` (internal UUID) |
| `sid` | `sessionId` (login session ID) |
| `exp` | `Date.now() + authTtlMs` (default 24 h) |

The signature is HMAC-SHA256 keyed on `OPENCLAW_DEPLOY_AUTH_SECRET` (default `"dev-secret-change-me"` — **must be overridden in production**).

The token is sent to the browser via SSE (`event: auth { token, expiresAt }`), stored client-side, and passed as `Authorization: Bearer <token>` on subsequent API calls to the deploy server.

---

## Credential File Layout

```
OPENCLAW_DEPLOY_AUTH_ROOT/           (default: /data/auth)
├── tmp/
│   └── ls_<sessionId>/              ← temp dir during login
│       └── wa-session-data/         ← Baileys writes creds here
│           ├── creds.json
│           ├── pre-key-*.json
│           └── ...
└── <userId>/                        ← permanent per-user dir
    ├── wa-session-data/             ← copied here after login
    │   ├── creds.json               ← presence = active WA session
    │   ├── pre-key-*.json
    │   └── ...
    ├── openclaw.json                ← gateway config (model, token)
    ├── openclaw.plugin.json         ← plugin manifest
    ├── clawdly-profile.js           ← profile injection plugin
    └── memory/
        └── user-profile.md          ← synthesised profile
```

---

## Gateway Container Auth

The gateway container (OpenClaw) also runs Baileys internally — using the **same `wa-session-data/creds.json`** as the login flow. This means:

- **Only one active WA connection at a time.** Two simultaneous Baileys instances with the same credentials will kick each other out. The provisioner stops any existing container before collecting sync data during reprovision.
- The gateway is authenticated to the deploy server via a **per-container gateway token** (`OPENCLAW_GATEWAY_TOKEN`) written into `openclaw.json`. This is a random 48-char hex string generated at provision time.

---

## Admin Token

The admin panel (`/admin`) is protected by a separate static token (`OPENCLAW_DEPLOY_ADMIN_TOKEN`). It is passed as the `x-admin-token` header or `adminToken` query parameter. If the env var is unset, admin is disabled entirely (returns 404).

The admin token is independent of the user JWT system — it grants access to all user data and control endpoints.

---

## Reset WA Session

Wiping `wa-session-data/` forces a fresh QR scan. This is important because:

- **Full sync only happens on first connection with new credentials.** Baileys fires `contacts.set` / `chats.set` with the complete contact/chat list only during initial registration. Subsequent reconnects with saved credentials deliver only incremental updates.
- Therefore, capturing rich profile data for synthesis requires deleting the credential files so that the next login triggers a full sync.

The admin panel's **Reset WA** button calls `POST /v1/admin/users/:userId/reset-wa-session`, which:
1. Closes all active login sessions for the user
2. Stops and removes the gateway container (`provisioner.deprovision`)
3. Deletes `wa-session-data/` recursively
4. The user must then scan a new QR at the login URL

The reprovision endpoint (`POST /v1/admin/users/:userId/reprovision`) skips `collectWhatsAppSyncData` if `creds.json` is absent, to avoid Baileys silently re-registering with a blank identity.
