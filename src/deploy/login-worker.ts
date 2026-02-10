import { createWaSocket, waitForWaConnection, readWebSelfId } from "./wa-session.js";
import type { DeployStore } from "./store.js";
import type { LoginSession } from "./types.js";
import { SessionEvents } from "./session-events.js";

export type LoginWorkerDeps = {
  store: DeployStore;
  events: SessionEvents;
  sessionTtlMs: number;
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
  const { store, events, sessionTtlMs } = deps;
  const expiresAt = session.expiresAt;
  let completed = false;
  let timeout: NodeJS.Timeout | null = null;
  let sock: Awaited<ReturnType<typeof createWaSocket>> | null = null;
  const maxAttempts = 3;

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
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      sock = await createWaSocket(false, false, {
        authDir: session.authDir,
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

      try {
        await waitForWaConnection(sock);
        break;
      } catch (err) {
        lastError = err;
        // Some WA flows persist creds but disconnect before `open`.
        if (await linkFromAuthDir()) {
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
        if (!completed) {
          closeSocket();
          sock = null;
        }
      }
    }

    if (completed) {
      return;
    }

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
