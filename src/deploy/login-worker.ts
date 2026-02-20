import { createWaSocket, waitForWaConnection, readWebSelfId } from "./wa-session.js";
import type { DeployStore } from "./store.js";
import type { LoginSession } from "./types.js";
import { SessionEvents } from "./session-events.js";

export type LoginWorkerDeps = {
  store: DeployStore;
  events: SessionEvents;
  sessionTtlMs: number;
  onProfileDataReady?: (userId: string) => void;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const getStatusCode = (err: unknown): number | undefined =>
  (err as { output?: { statusCode?: number } })?.output?.statusCode ??
  (err as { status?: number })?.status;

const isRetryableDisconnect = (err: unknown) => {
  const code = getStatusCode(err);
  return code === 408 || code === 410 || code === 428 || code === 440 || code === 500 || code === 515;
};

const formatLoginError = (err: unknown): string => {
  if (err instanceof Error) {
    return err.message;
  }
  if (typeof err === "string") {
    return err;
  }
  if (!err || typeof err !== "object") {
    return String(err);
  }
  const statusCode = getStatusCode(err);
  const code = (err as { code?: unknown }).code;
  const message =
    (err as { message?: unknown }).message ??
    (err as { error?: { message?: unknown } }).error?.message ??
    (err as { output?: { payload?: { message?: unknown } } }).output?.payload?.message;
  const parts = [
    typeof statusCode === "number" ? `status=${statusCode}` : null,
    typeof code === "string" || typeof code === "number" ? `code=${String(code)}` : null,
    typeof message === "string" ? message : null,
  ].filter((value): value is string => Boolean(value));
  if (parts.length > 0) {
    return parts.join(" ");
  }
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
};

export const runLoginWorker = async (
  session: LoginSession,
  deps: LoginWorkerDeps,
): Promise<void> => {
  const { store, events, sessionTtlMs, onProfileDataReady } = deps;
  const expiresAt = session.expiresAt;
  let completed = false;
  let timeout: NodeJS.Timeout | null = null;
  let sock: Awaited<ReturnType<typeof createWaSocket>> | null = null;
  const maxAttempts = 3;

  // Accumulate WhatsApp sync data emitted by Baileys during session establishment.
  // These events fire during the connection hold window and give us rich context
  // about the user (contacts, chats, recent messages) for profile synthesis.
  let capturedUserId: string | null = null;
  const syncData = {
    displayName: null as string | null,
    contacts: [] as unknown[],
    chats: [] as unknown[],
    messages: [] as unknown[],
  };

  const handleExpire = async () => {
    if (completed) {
      return;
    }
    completed = true;
    if (sock?.ws) {
      try {
        sock.ws.close();
      } catch {
        // ignore
      }
    }
    await store.updateLoginSession(session.id, {
      state: "expired",
      errorCode: "SESSION_EXPIRED",
      errorMessage: "QR session expired.",
    });
    events.emit(session.id, {
      type: "error",
      code: "SESSION_EXPIRED",
      message: "QR session expired. Please refresh the QR code.",
    });
  };

  const closeSocket = () => {
    if (!sock?.ws) {
      return;
    }
    try {
      sock.ws.close();
    } catch {
      // ignore
    }
  };

  const linkFromAuthDir = async () => {
    const { e164 } = readWebSelfId(session.authDir);
    if (!e164) {
      return false;
    }
    const user = await store.getOrCreateUserByWhatsappId(e164);
    capturedUserId = user.id;
    await store.updateLoginSession(session.id, {
      state: "linked",
      whatsappId: e164,
      userId: user.id,
    });
    events.emit(session.id, {
      type: "status",
      state: "linked",
      message: "WhatsApp linked.",
    });
    return true;
  };

  try {
    events.emit(session.id, {
      type: "status",
      state: "waiting",
      message: "Waiting for QR scan.",
    });
    timeout = setTimeout(handleExpire, sessionTtlMs);

    let lastError: unknown = null;
    let connected = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let connectedSockEv: any = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      sock = await createWaSocket(false, false, {
        authDir: session.authDir,
        // syncFullHistory:true tells Baileys to process HISTORY_SYNC_NOTIFICATION messages
        // from WA instead of discarding them. Without this, shouldSyncHistoryMessage()
        // returns false and messaging-history.set is never emitted even if WA sends it
        // (which it does right after a fresh QR scan — visible as "syncing" on the phone).
        syncFullHistory: true,
        onQr: async (qr) => {
          if (completed) {
            return;
          }
          events.emit(session.id, {
            type: "qr",
            qr,
            expiresAt,
          });
        },
      });

      // Attach sync event listeners immediately after socket creation.
      // Baileys fires these during and shortly after the handshake, giving us
      // the user's contact list, chat list, and recent message history.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sockEv = (sock as any)?.ev;
      if (sockEv) {
        // Primary: Baileys v7 bulk-sync event (only arrives when WA sends HISTORY_SYNC_NOTIFICATION)
        sockEv.on(
          "messaging-history.set",
          ({ contacts, chats, messages }: { contacts: unknown[]; chats: unknown[]; messages: unknown[] }) => {
            syncData.contacts = (contacts ?? []).slice(0, 500);
            syncData.chats = (chats ?? []).slice(0, 200);
            syncData.messages = (messages ?? []).slice(0, 1000);
            // eslint-disable-next-line no-console
            console.log(`[login-worker] messaging-history.set: ${syncData.contacts.length} contacts, ${syncData.chats.length} chats, ${syncData.messages.length} messages`);
          },
        );
        // Fallback: incremental upsert events that fire even without a history sync notification.
        // WA pushes these during and after the initial handshake regardless of syncFullHistory.
        sockEv.on("chats.upsert", (chats: unknown[]) => {
          if (chats?.length) {
            syncData.chats = [...syncData.chats, ...chats].slice(0, 200);
          }
        });
        sockEv.on("contacts.upsert", (contacts: unknown[]) => {
          if (contacts?.length) {
            syncData.contacts = [...syncData.contacts, ...contacts].slice(0, 500);
          }
        });
      }

      try {
        await waitForWaConnection(sock);
        connected = true;
        connectedSockEv = sockEv;
        break;
      } catch (err) {
        lastError = err;
        // Some WA flows persist creds but disconnect before `open`.
        // This is normal in WA's multi-device reconnect flow: creds.json is
        // written during the handshake, then WA immediately closes the socket
        // before firing "open". If credentials are already on disk, retry the
        // connection instead of returning early — the next attempt will open
        // cleanly and fire messaging-history.set for profile capture.
        if (await linkFromAuthDir()) {
          if (attempt < maxAttempts) {
            // eslint-disable-next-line no-console
            console.log(`[login-worker] creds arrived during reconnect (attempt ${attempt}), retrying for sync data`);
            await sleep(500);
            continue;
          }
          completed = true;
          return;
        }
        if (attempt < maxAttempts && isRetryableDisconnect(err)) {
          events.emit(session.id, {
            type: "status",
            state: "waiting",
            message: "Reconnecting to WhatsApp...",
          });
          await sleep(1000);
          continue;
        }
        throw err;
      } finally {
        // Only close the socket on error/retry, not on success.
        // On success we need the socket to stay open so Baileys can
        // sync session state (pre-keys, sender-keys, app-state-sync-keys).
        if (!completed && !connected) {
          closeSocket();
          sock = null;
        }
      }
    }

    if (completed) {
      return;
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    syncData.displayName = (sock as any)?.user?.name ?? null;
    // eslint-disable-next-line no-console
    console.log(`[login-worker] connected displayName=${syncData.displayName ?? "(none)"}, waiting for sync events`);

    // Wait for sync events from WA. Exit early once we have contacts or chats from
    // any source: messaging-history.set (bulk), chats.upsert, or contacts.upsert.
    //
    // WHY 90s: WA sends HISTORY_SYNC_NOTIFICATION to "the next stable connection"
    // after device registration. That connection is US — but only while our socket
    // is open. If we close too early (e.g. 45s), WA defers the notification to the
    // next connection, which is the gateway container starting at ~t+55s. The gateway
    // then consumes the notification, and our deferred sync (3 min later) gets nothing.
    //
    // Baileys' own internal AwaitingInitialSync timeout fires at 20s and transitions
    // to Online state. After that, a late HISTORY_SYNC_NOTIFICATION is still processed
    // by processMessage and emits messaging-history.set immediately (no buffering).
    // Our listener below catches it. So 90s keeps the socket alive long enough to
    // capture notifications that arrive at ~60-80s after QR scan.
    //
    // The early-exit logic means we return immediately when data arrives — typical
    // fast accounts resolve in seconds, not the full 90s.
    const SYNC_TIMEOUT_MS = 90_000;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (reason: string) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        // eslint-disable-next-line no-console
        console.log(`[login-worker] sync wait ended (${reason}) — contacts=${syncData.contacts.length} chats=${syncData.chats.length} messages=${syncData.messages.length}`);
        resolve();
      };
      const timer = setTimeout(() => finish("timeout"), SYNC_TIMEOUT_MS);
      const tryEarlyExit = (source: string) => {
        if (syncData.contacts.length > 0 || syncData.chats.length > 0) {
          finish(source);
        }
      };
      tryEarlyExit("already-received"); // in case events fired before this promise
      if (connectedSockEv) {
        connectedSockEv.on("messaging-history.set", () => setTimeout(() => tryEarlyExit("messaging-history.set"), 100));
        connectedSockEv.on("chats.upsert", () => setTimeout(() => tryEarlyExit("chats.upsert"), 100));
        connectedSockEv.on("contacts.upsert", () => setTimeout(() => tryEarlyExit("contacts.upsert"), 100));
      }
    });
    closeSocket();
    sock = null;

    // Give auth state a brief chance to flush to disk after socket open.
    let linked = false;
    for (let i = 0; i < 5; i += 1) {
      linked = await linkFromAuthDir();
      if (linked) {
        break;
      }
      await sleep(300);
    }
    if (!linked) {
      throw new Error(
        formatLoginError(lastError) || "WhatsApp linked but identity was not persisted.",
      );
    }

    // Persist the WhatsApp sync data collected during the hold window.
    // Fire-and-forget — don't block the login flow on DB write.
    if (capturedUserId) {
      void store.upsertRawProfileData(capturedUserId, syncData).catch(() => {});
      onProfileDataReady?.(capturedUserId);
    }

    completed = true;
  } catch (err) {
    if (completed) {
      return;
    }
    completed = true;
    if (timeout) {
      clearTimeout(timeout);
    }
    // Last-chance recovery if creds landed right before an error bubble-up.
    if (await linkFromAuthDir()) {
      return;
    }
    const errorMessage = formatLoginError(err);
    // eslint-disable-next-line no-console
    console.error(`login-worker failed for ${session.id}: ${errorMessage}`);
    await store.updateLoginSession(session.id, {
      state: "error",
      errorCode: "LOGIN_FAILED",
      errorMessage,
    });
    events.emit(session.id, {
      type: "error",
      code: "LOGIN_FAILED",
      message: "WhatsApp login failed. Please retry.",
    });
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    closeSocket();
  }
};
