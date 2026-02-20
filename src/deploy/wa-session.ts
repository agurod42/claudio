import {
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  makeWASocket,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import fs from "node:fs";
import path from "node:path";

type WaConnectionState = Partial<import("@whiskeysockets/baileys").ConnectionState>;

const noop = () => {};

const createSilentLogger = () => {
  const logger = {
    level: "silent",
    trace: noop,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    fatal: noop,
    child: () => logger,
  };
  return logger;
};

const jidToE164 = (jid: string): string | null => {
  const match = jid.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted)$/);
  if (!match) {
    return null;
  }
  return `+${match[1]}`;
};

export async function createWaSocket(
  _printQr: boolean,
  _verbose: boolean,
  opts: { authDir?: string; onQr?: (qr: string) => void; syncFullHistory?: boolean } = {},
) {
  const authDir = opts.authDir?.trim();
  if (!authDir) {
    throw new Error("authDir is required");
  }
  await fs.promises.mkdir(authDir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();
  const logger = createSilentLogger();

  const sock = makeWASocket({
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    version,
    logger,
    printQRInTerminal: false,
    browser: ["Claudio", "web", "1.0.0"],
    syncFullHistory: opts.syncFullHistory ?? false,
    markOnlineOnConnect: false,
  });

  sock.ev.on("creds.update", () => {
    void saveCreds();
  });

  sock.ev.on("connection.update", (update: WaConnectionState) => {
    if (update.qr) {
      opts.onQr?.(update.qr);
    }
  });

  return sock;
}

export async function waitForWaConnection(sock: ReturnType<typeof makeWASocket>) {
  return new Promise<void>((resolve, reject) => {
    const handler = (update: WaConnectionState) => {
      if (update.connection === "open") {
        sock.ev.off("connection.update", handler);
        resolve();
        return;
      }
      if (update.connection === "close") {
        sock.ev.off("connection.update", handler);
        reject(update.lastDisconnect ?? new Error("Connection closed"));
      }
    };
    sock.ev.on("connection.update", handler);
  });
}

// ---------------------------------------------------------------------------
// Collect WhatsApp sync data using existing credentials (no QR needed).
// Used during reprovision to seed the profile with real WhatsApp data for
// users whose session was established before the capture code was added.
// IMPORTANT: the gateway container MUST be stopped before calling this to
// avoid two simultaneous WhatsApp connections with the same credentials.
// ---------------------------------------------------------------------------

export type WaSyncData = {
  displayName: string | null;
  contacts: unknown[];
  chats: unknown[];
  messages: unknown[];
};

export async function collectWhatsAppSyncData(
  authDir: string,
  timeoutMs = 10_000,
): Promise<WaSyncData> {
  const syncData: WaSyncData = {
    displayName: null,
    contacts: [],
    chats: [],
    messages: [],
  };

  // eslint-disable-next-line no-console
  console.log(`[wa-sync] connecting to WhatsApp to collect sync data from ${authDir}`);

  // syncFullHistory:true asks Baileys to request a full history sync from WA,
  // which causes WA to send a HISTORY_SYNC_NOTIFICATION and fire messaging-history.set.
  const sock = await createWaSocket(false, false, { authDir, syncFullHistory: true });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sockEv = (sock as any)?.ev;
  let earlyResolve: (() => void) | null = null;

  const checkEarlyExit = () => {
    if (syncData.contacts.length > 0 || syncData.chats.length > 0) {
      earlyResolve?.();
    }
  };

  if (sockEv) {
    // Primary: Baileys v7 bulk-sync event (only arrives when WA sends HISTORY_SYNC_NOTIFICATION)
    sockEv.on(
      "messaging-history.set",
      ({ contacts, chats, messages }: { contacts: unknown[]; chats: unknown[]; messages: unknown[] }) => {
        syncData.contacts = (contacts ?? []).slice(0, 500);
        syncData.chats = (chats ?? []).slice(0, 200);
        syncData.messages = (messages ?? []).slice(0, 1000);
        // eslint-disable-next-line no-console
        console.log(`[wa-sync] messaging-history.set: ${syncData.contacts.length} contacts, ${syncData.chats.length} chats, ${syncData.messages.length} messages`);
        checkEarlyExit();
      },
    );
    // Fallback: incremental upsert events that fire even without a history sync notification
    sockEv.on("chats.upsert", (chats: unknown[]) => {
      if (chats?.length) {
        syncData.chats = [...syncData.chats, ...chats].slice(0, 200);
        // eslint-disable-next-line no-console
        console.log(`[wa-sync] chats.upsert: +${chats.length} → total=${syncData.chats.length}`);
        checkEarlyExit();
      }
    });
    sockEv.on("contacts.upsert", (contacts: unknown[]) => {
      if (contacts?.length) {
        syncData.contacts = [...syncData.contacts, ...contacts].slice(0, 500);
        // eslint-disable-next-line no-console
        console.log(`[wa-sync] contacts.upsert: +${contacts.length} → total=${syncData.contacts.length}`);
        checkEarlyExit();
      }
    });
  }

  try {
    await waitForWaConnection(sock);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    syncData.displayName = (sock as any)?.user?.name ?? null;
    // eslint-disable-next-line no-console
    console.log(`[wa-sync] connected displayName=${syncData.displayName ?? "(none)"}, waiting up to ${timeoutMs}ms for sync events`);
    await new Promise<void>((resolve) => {
      earlyResolve = resolve;
      setTimeout(resolve, timeoutMs);
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[wa-sync] connection error (still returning whatever was collected): ${String(err)}`);
  } finally {
    earlyResolve = null;
    try {
      sock.ws.close();
    } catch {
      // ignore
    }
  }

  // eslint-disable-next-line no-console
  console.log(
    `[wa-sync] sync complete: contacts=${syncData.contacts.length} chats=${syncData.chats.length} messages=${syncData.messages.length}`,
  );
  return syncData;
}

export function readWebSelfId(authDir: string) {
  try {
    const credsPath = path.join(authDir, "creds.json");
    const raw = fs.readFileSync(credsPath, "utf-8");
    const parsed = JSON.parse(raw) as { me?: { id?: string } };
    const jid = parsed?.me?.id ?? null;
    const e164 = jid ? jidToE164(jid) : null;
    return { e164, jid } as const;
  } catch {
    return { e164: null, jid: null } as const;
  }
}
