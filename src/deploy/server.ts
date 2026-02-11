import express from "express";
import Docker from "dockerode";
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

const getAdminTokenFromRequest = (req: express.Request) => {
  const explicit = req.header("x-admin-token");
  if (explicit && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const authHeader = req.header("authorization");
  if (authHeader) {
    const [scheme, token] = authHeader.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token?.trim()) {
      return token.trim();
    }
  }
  const queryToken =
    typeof req.query.adminToken === "string" && req.query.adminToken.trim().length > 0
      ? req.query.adminToken.trim()
      : null;
  return queryToken;
};

const isAdminDisabled = () => deployConfig.env === "production" && !deployConfig.adminToken.trim();

const getProxyHeaderValue = (value: string | string[] | undefined) => {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value) && value.length > 0) {
    return value[0];
  }
  return null;
};

const readGatewayTokenFromConfig = async (authDirPath: string): Promise<string | null> => {
  try {
    const configPath = path.join(authDirPath, "openclaw.json");
    const raw = await fs.readFile(configPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      gateway?: { auth?: { token?: unknown } };
    };
    const token = parsed?.gateway?.auth?.token;
    if (typeof token === "string" && token.trim().length > 0) {
      return token.trim();
    }
    return null;
  } catch {
    return null;
  }
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
  const adminDocker = provisioner instanceof DockerProvisioner ? new Docker() : null;
  const adminToken = deployConfig.adminToken.trim();

  const requireAdmin: express.RequestHandler = (req, res, next) => {
    if (isAdminDisabled()) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (!adminToken) {
      next();
      return;
    }
    const candidate = getAdminTokenFromRequest(req);
    if (candidate !== adminToken) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };

  const inspectGatewayRuntime = async (containerId: string) => {
    if (!adminDocker) {
      return null;
    }
    try {
      const info = await adminDocker.getContainer(containerId).inspect();
      const networkData = Object.values(info.NetworkSettings?.Networks ?? {});
      const ip = networkData.find((entry) => entry?.IPAddress)?.IPAddress ?? null;
      return {
        running: Boolean(info.State?.Running),
        status: info.State?.Status ?? "unknown",
        ip,
      };
    } catch {
      return null;
    }
  };

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

  app.get("/admin", (_req, res) => {
    res.sendFile(path.join(staticDir, "admin.html"));
  });

  app.get("/v1/admin/overview", requireAdmin, async (_req, res) => {
    const [users, agents, sessions, gateways] = await Promise.all([
      store.listUsers(),
      store.listAgents(),
      store.listLoginSessions(),
      store.listGatewayInstances(),
    ]);

    const sortedSessions = [...sessions].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const sortedGateways = [...gateways].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const agentByUserId = new Map(agents.map((agent) => [agent.userId, agent]));
    const latestSessionByUserId = new Map<string, (typeof sortedSessions)[number]>();
    const latestGatewayByUserId = new Map<string, (typeof sortedGateways)[number]>();

    for (const session of sortedSessions) {
      if (!session.userId || latestSessionByUserId.has(session.userId)) {
        continue;
      }
      latestSessionByUserId.set(session.userId, session);
    }

    for (const gateway of sortedGateways) {
      if (latestGatewayByUserId.has(gateway.userId)) {
        continue;
      }
      latestGatewayByUserId.set(gateway.userId, gateway);
    }

    const runtimeByContainerId = new Map<
      string,
      Awaited<ReturnType<typeof inspectGatewayRuntime>>
    >();
    const containerIds = Array.from(
      new Set(
        sortedGateways
          .map((gateway) => gateway.containerId)
          .filter((containerId): containerId is string => Boolean(containerId)),
      ),
    );
    await Promise.all(
      containerIds.map(async (containerId) => {
        runtimeByContainerId.set(containerId, await inspectGatewayRuntime(containerId));
      }),
    );

    const usersSummary = users.map((user) => {
      const agent = agentByUserId.get(user.id) ?? null;
      const latestSession = latestSessionByUserId.get(user.id) ?? null;
      const gateway = latestGatewayByUserId.get(user.id) ?? null;
      const runtime =
        gateway?.containerId && runtimeByContainerId.has(gateway.containerId)
          ? runtimeByContainerId.get(gateway.containerId)
          : null;
      const proxyBasePath = gateway ? `/admin/openclaw/${encodeURIComponent(user.id)}/` : null;
      return {
        userId: user.id,
        whatsappId: user.whatsappId,
        status: user.status,
        createdAt: user.createdAt.toISOString(),
        agent: agent
          ? {
              id: agent.id,
              modelTier: agent.modelTier,
              name: agent.name,
              tone: agent.tone,
              language: agent.language,
              allowlistOnly: agent.allowlistOnly,
              createdAt: agent.createdAt.toISOString(),
            }
          : null,
        gateway: gateway
          ? {
              id: gateway.id,
              status: gateway.status,
              containerId: gateway.containerId,
              authDirPath: gateway.authDirPath,
              createdAt: gateway.createdAt.toISOString(),
              runtimeStatus: runtime?.status ?? null,
              runtimeRunning: runtime?.running ?? null,
              runtimeIp: runtime?.ip ?? null,
              proxyBasePath,
              canvasPath: proxyBasePath ? `${proxyBasePath}__openclaw__/canvas/` : null,
            }
          : null,
        latestSession: latestSession
          ? {
              id: latestSession.id,
              state: latestSession.state,
              expiresAt: latestSession.expiresAt.toISOString(),
              createdAt: latestSession.createdAt.toISOString(),
              errorCode: latestSession.errorCode ?? null,
              errorMessage: latestSession.errorMessage ?? null,
            }
          : null,
      };
    });

    const sessionsSummary = sortedSessions.map((session) => ({
      id: session.id,
      state: session.state,
      userId: session.userId ?? null,
      whatsappId: session.whatsappId ?? null,
      createdAt: session.createdAt.toISOString(),
      expiresAt: session.expiresAt.toISOString(),
      errorCode: session.errorCode ?? null,
      errorMessage: session.errorMessage ?? null,
    }));

    const gatewaysSummary = sortedGateways.map((gateway) => {
      const runtime =
        gateway.containerId && runtimeByContainerId.has(gateway.containerId)
          ? runtimeByContainerId.get(gateway.containerId)
          : null;
      const proxyBasePath = `/admin/openclaw/${encodeURIComponent(gateway.userId)}/`;
      return {
        id: gateway.id,
        userId: gateway.userId,
        status: gateway.status,
        containerId: gateway.containerId,
        authDirPath: gateway.authDirPath,
        createdAt: gateway.createdAt.toISOString(),
        runtimeStatus: runtime?.status ?? null,
        runtimeRunning: runtime?.running ?? null,
        runtimeIp: runtime?.ip ?? null,
        proxyBasePath,
        canvasPath: `${proxyBasePath}__openclaw__/canvas/`,
      };
    });

    const stats = {
      usersTotal: users.length,
      usersActive: users.filter((item) => item.status === "active").length,
      agentsTotal: agents.length,
      gatewaysTotal: gateways.length,
      gatewaysRunning: gateways.filter((item) => item.status === "running").length,
      gatewaysError: gateways.filter((item) => item.status === "error").length,
      sessionsTotal: sessions.length,
      sessionsWaiting: sessions.filter((item) => item.state === "waiting").length,
      sessionsDeploying: sessions.filter((item) => item.state === "deploying").length,
      sessionsReady: sessions.filter((item) => item.state === "ready").length,
      sessionsExpired: sessions.filter((item) => item.state === "expired").length,
      sessionsError: sessions.filter((item) => item.state === "error").length,
    };

    res.json({
      generatedAt: new Date().toISOString(),
      authMode: adminToken ? "token" : "open",
      stats,
      users: usersSummary,
      gateways: gatewaysSummary,
      sessions: sessionsSummary,
    });
  });

  app.use("/admin/openclaw/:userId", requireAdmin, async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    if (!adminDocker) {
      res.status(400).json({ error: "docker_provisioner_required" });
      return;
    }

    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    if (!userId) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    const gateway = await store.getGatewayInstanceByUserId(userId);
    if (!gateway || !gateway.containerId) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    const runtime = await inspectGatewayRuntime(gateway.containerId);
    if (!runtime?.running || !runtime.ip) {
      res.status(503).json({ error: "gateway_not_running" });
      return;
    }

    const requestedPath = req.url && req.url.length > 0 ? req.url : "/";
    const targetUrl = `http://${runtime.ip}:18789${requestedPath.startsWith("/") ? requestedPath : `/${requestedPath}`}`;

    try {
      const acceptHeader = getProxyHeaderValue(req.headers.accept);
      const gatewayToken = await readGatewayTokenFromConfig(gateway.authDirPath);
      const headers: Record<string, string> = {};
      if (acceptHeader) {
        headers.accept = acceptHeader;
      }
      if (gatewayToken) {
        headers.authorization = `Bearer ${gatewayToken}`;
      }
      const upstream = await fetch(targetUrl, {
        method: req.method,
        redirect: "manual",
        headers,
      });
      const blockedHeaders = new Set(["connection", "keep-alive", "transfer-encoding"]);
      res.status(upstream.status);
      upstream.headers.forEach((value, key) => {
        if (!blockedHeaders.has(key.toLowerCase())) {
          res.setHeader(key, value);
        }
      });
      if (!upstream.body || req.method === "HEAD") {
        res.end();
        return;
      }
      const body = Buffer.from(await upstream.arrayBuffer());
      res.send(body);
    } catch {
      res.status(502).json({ error: "upstream_unreachable" });
    }
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
