import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { deployConfig } from "./config.js";
import { initDatabase } from "./db.js";
import { runLoginWorker } from "./login-worker.js";
import { NoopProvisioner } from "./provisioner.js";
import { DockerProvisioner } from "./provisioner-docker.js";
import { SessionEvents } from "./session-events.js";
import {
  createLoginSessionRecord,
  createStore,
  defaultAgentSettings,
  resolveBaseUrl,
} from "./store.js";
import type { SessionEvent } from "./session-events.js";
import { issueToken, verifyToken } from "./auth.js";

const toJson = (value: unknown) => JSON.stringify(value);

const resolveStaticDir = () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "public");
};

const sendSse = (res: express.Response, event: string, payload: unknown) => {
  res.write(`event: ${event}\n`);
  res.write(`data: ${toJson(payload)}\n\n`);
};

const sendSseSafe = (res: express.Response, event: string, payload: unknown) => {
  try {
    sendSse(res, event, payload);
  } catch {
    // client disconnected
  }
};

const renderQrDataUrl = async (qr: string) => {
  try {
    return await QRCode.toDataURL(qr, {
      margin: 1,
      width: 260,
      color: { dark: "#1e1c17", light: "#ffffff" },
    });
  } catch {
    return null;
  }
};

const sendQrSse = async (
  res: express.Response,
  payload: { qr: string; expiresAt?: Date | null },
) => {
  const image = await renderQrDataUrl(payload.qr);
  sendSseSafe(res, "qr", {
    qr: payload.qr,
    image,
    expiresAt: payload.expiresAt ?? null,
  });
};

const getUserId = (req: express.Request) => {
  const authHeader = req.header("authorization");
  if (!authHeader) {
    return null;
  }
  const [scheme, token] = authHeader.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }
  const payload = verifyToken(token);
  if (!payload) {
    return null;
  }
  return payload.sub;
};

const start = async () => {
  const pool = await initDatabase();
  const store = createStore(pool);
  const events = new SessionEvents();
  const provisioner =
    deployConfig.provisioner === "docker"
      ? new DockerProvisioner(store)
      : new NoopProvisioner(store);
  const stopReaper =
    provisioner instanceof DockerProvisioner
      ? provisioner.startReaper(deployConfig.reaperIntervalMs, deployConfig.reaperMaxAgeMs)
      : null;
  const activeSessions = new Map<string, Promise<void>>();
  const sessionUsers = new Map<string, string>();
  const baseUrl = resolveBaseUrl(deployConfig.port);

  const startSessionFlow = (sessionId: string, authDir: string) => {
    if (activeSessions.has(sessionId)) {
      return;
    }
    const task = (async () => {
      try {
        const session = await store.getLoginSession(sessionId);
        if (!session) {
          return;
        }
        await runLoginWorker(session, {
          store,
          events,
          sessionTtlMs: deployConfig.sessionTtlMs,
        });
        const linked = await store.getLoginSession(sessionId);
        if (!linked || linked.state !== "linked" || !linked.userId || !linked.whatsappId) {
          return;
        }
        sessionUsers.set(sessionId, linked.userId);
        await store.updateLoginSession(sessionId, { state: "deploying" });
        events.emit(sessionId, {
          type: "status",
          state: "deploying",
          message: "Deploying your agent.",
        });
        const existingAgent = await store.getAgentByUserId(linked.userId);
        if (!existingAgent) {
          await store.createAgentForUser(linked.userId, defaultAgentSettings());
        }
        await provisioner.provision(linked.userId, authDir, linked.whatsappId);
        await store.updateLoginSession(sessionId, { state: "ready" });
        events.emit(sessionId, {
          type: "status",
          state: "ready",
          message: "Your agent is live on WhatsApp.",
        });
      } catch (err) {
        await store.updateLoginSession(sessionId, {
          state: "error",
          errorCode: "PROVISION_FAILED",
          errorMessage: String(err),
        });
        events.emit(sessionId, {
          type: "error",
          code: "PROVISION_FAILED",
          message: "Provisioning failed. Please retry.",
        });
      }
    })();
    activeSessions.set(sessionId, task);
    task.finally(() => activeSessions.delete(sessionId));
  };

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const staticDir = resolveStaticDir();
  app.use(express.static(staticDir));

  app.get("/", (_req, res) => {
    res.sendFile(path.join(staticDir, "index.html"));
  });

  app.post("/v1/login-sessions", async (_req, res) => {
    const expiresAt = new Date(Date.now() + deployConfig.sessionTtlMs);
    const session = createLoginSessionRecord({ authDir: "", expiresAt });
    const sessionId = session.id;
    const authDir = path.join(deployConfig.authRoot, sessionId);
    await fs.mkdir(authDir, { recursive: true });
    session.authDir = authDir;
    await store.createLoginSession(session);
    startSessionFlow(sessionId, authDir);
    res.json({
      sessionId,
      streamUrl: `${baseUrl}/v1/login-sessions/${sessionId}/stream`,
      expiresAt: expiresAt.toISOString(),
    });
  });

  app.get("/v1/login-sessions/:id", async (req, res) => {
    const session = await store.getLoginSession(req.params.id);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      id: session.id,
      state: session.state,
      expiresAt: session.expiresAt.toISOString(),
      userId: session.userId,
      whatsappId: session.whatsappId,
      errorCode: session.errorCode,
      errorMessage: session.errorMessage,
    });
  });

  app.get("/v1/login-sessions/:id/stream", async (req, res) => {
    const sessionId = req.params.id;
    const session = await store.getLoginSession(sessionId);
    if (!session) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const snapshot = events.snapshot(sessionId);
    if (snapshot) {
      sendSseSafe(res, "status", { state: snapshot.state, message: snapshot.message });
      if (snapshot.qr) {
        await sendQrSse(res, { qr: snapshot.qr, expiresAt: snapshot.qrExpiresAt ?? null });
      }
      if (snapshot.error) {
        sendSseSafe(res, "error", snapshot.error);
      }
    } else {
      sendSseSafe(res, "status", { state: session.state, message: "Waiting for QR scan." });
    }

    const sendAuth = (userId: string) => {
      sendSseSafe(res, "auth", {
        token: issueToken(userId, sessionId),
        expiresAt: new Date(Date.now() + deployConfig.authTtlMs).toISOString(),
      });
    };

    if (session.state === "ready" && session.userId) {
      sendAuth(session.userId);
    }

    const handler = (event: SessionEvent) => {
      if (event.type === "qr") {
        void sendQrSse(res, { qr: event.qr, expiresAt: event.expiresAt });
      }
      if (event.type === "status") {
        sendSseSafe(res, "status", { state: event.state, message: event.message });
        if (event.state === "ready") {
          const userId = sessionUsers.get(sessionId);
          if (userId) {
            sendAuth(userId);
          }
        }
      }
      if (event.type === "error") {
        sendSseSafe(res, "error", { code: event.code, message: event.message });
      }
    };

    const unsubscribe = events.on(sessionId, handler);
    const heartbeat = setInterval(() => {
      res.write(":keep-alive\n\n");
    }, 15000);

    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.get("/v1/me", async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "missing_user" });
      return;
    }
    res.json({ userId });
  });

  app.get("/v1/agent", async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "missing_user" });
      return;
    }
    const agent = await store.getAgentByUserId(userId);
    if (!agent) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    const gateway = await store.getGatewayInstanceByUserId(userId);
    let gatewayStatus = gateway?.status ?? null;
    if (gateway && provisioner instanceof DockerProvisioner) {
      const refreshed = await provisioner.refreshInstance(gateway);
      gatewayStatus = refreshed?.status ?? gatewayStatus;
    }
    res.json({
      agentId: agent.id,
      status: "running",
      modelTier: agent.modelTier,
      name: agent.name,
      tone: agent.tone,
      language: agent.language,
      allowlistOnly: agent.allowlistOnly,
      gatewayStatus,
    });
  });

  app.patch("/v1/agent", async (req, res) => {
    const userId = getUserId(req);
    if (!userId) {
      res.status(401).json({ error: "missing_user" });
      return;
    }
    const update = req.body ?? {};
    const next = await store.updateAgentSettings(userId, {
      name: typeof update.name === "string" ? update.name : undefined,
      tone: typeof update.tone === "string" ? update.tone : undefined,
      language: typeof update.language === "string" ? update.language : undefined,
      modelTier:
        update.modelTier === "best" || update.modelTier === "fast" || update.modelTier === "premium"
          ? update.modelTier
          : undefined,
      allowlistOnly:
        typeof update.allowlistOnly === "boolean" ? update.allowlistOnly : undefined,
    });
    if (!next) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({
      agentId: next.id,
      status: "running",
      modelTier: next.modelTier,
      name: next.name,
      tone: next.tone,
      language: next.language,
      allowlistOnly: next.allowlistOnly,
    });
  });

  app.listen(deployConfig.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Deploy web listening on ${baseUrl}`);
  });

  const shutdown = () => {
    if (stopReaper) {
      stopReaper();
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
};

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Deploy web failed to start", err);
  process.exit(1);
});
