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
  opts: { authDir?: string; onQr?: (qr: string) => void } = {},
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
    browser: ["clawdly-deploy", "web", "1.0.0"],
    syncFullHistory: false,
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
