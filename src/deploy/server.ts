import express from "express";
import { STATUS_CODES, type IncomingMessage, request as httpRequest } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import QRCode from "qrcode";
import { deployConfig } from "./config.js";
import { initDatabase } from "./db.js";
import { runLoginWorker } from "./login-worker.js";
import { NoopProvisioner } from "./provisioner.js";
import { DockerProvisioner } from "./provisioner-docker.js";
import type { Provisioner } from "./provisioner.js";
import { SessionEvents } from "./session-events.js";
import {
  createLoginSessionRecord,
  createStore,
  defaultAgentSettings,
  resolveBaseUrl,
} from "./store.js";
import type { SessionEvent } from "./session-events.js";
import { issueToken, verifyToken } from "./auth.js";
import { appendAgentNoteToProfile, projectUserProfile } from "./profile-synthesizer.js";
import { collectWhatsAppSyncData } from "./wa-session.js";
import type { GatewayInstanceRecord, ModelTier } from "./types.js";
import {
  DEFAULT_BROWSER_DEFAULT_PROFILE,
  DEFAULT_BROWSER_ENABLED,
  DEFAULT_BROWSER_HEADLESS,
  DEFAULT_BROWSER_NO_SANDBOX,
  DEFAULT_GATEWAY_ROOT_DIR,
  DEFAULT_GATEWAY_WHATSAPP_AUTH_DIR,
  DEFAULT_TOOLS_ALSO_ALLOW,
  DEFAULT_TOOLS_PROFILE,
  resolveContextTokensForTier,
  resolveModelFallbacksForTier,
  resolvePrimaryModelForTier,
} from "./gateway-policy.js";
import { buildWhatsAppDirectoryPeers, type WhatsAppDirectoryPeer } from "./whatsapp-directory.js";
import {
  appendConversationLogEntry,
  runConversationSummarySweep,
  runIncrementalProfileUpdate,
} from "./profile-live-updater.js";

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

const getAdminTokenFromIncomingRequest = (req: IncomingMessage) => {
  const explicit = req.headers["x-admin-token"];
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim();
  }
  const authHeader = req.headers.authorization;
  if (typeof authHeader === "string") {
    const [scheme, token] = authHeader.split(" ");
    if (scheme?.toLowerCase() === "bearer" && token?.trim()) {
      return token.trim();
    }
  }
  try {
    const rawUrl = req.url ?? "/";
    const parsed = new URL(rawUrl, "http://localhost");
    const queryToken = parsed.searchParams.get("adminToken");
    if (queryToken && queryToken.trim().length > 0) {
      return queryToken.trim();
    }
  } catch {
    // ignore
  }
  return null;
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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const normalizeOrigin = (value: string | null | undefined) => {
  const trimmed = value?.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return new URL(trimmed).origin;
  } catch {
    return null;
  }
};

const resolveDefaultControlUiAllowedOrigins = () => {
  const candidates = [
    deployConfig.baseUrl,
    `http://localhost:${deployConfig.port}`,
    `http://127.0.0.1:${deployConfig.port}`,
    `http://[::1]:${deployConfig.port}`,
  ];
  const unique = new Set<string>();
  for (const candidate of candidates) {
    const normalized = normalizeOrigin(candidate);
    if (normalized) {
      unique.add(normalized);
    }
  }
  return Array.from(unique);
};

type NormalizedWhatsAppDirectoryPeer = {
  id: string;
  name?: string;
  handle?: string;
  accountId?: string;
};

const normalizeDirectoryPeerText = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
};

const normalizeWhatsAppDirectoryPeerId = (value: unknown): string | null => {
  const raw = normalizeDirectoryPeerText(value);
  if (!raw) {
    return null;
  }
  const digits = raw.replace(/[^\d]/g, "");
  if (/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted|lid)$/i.test(raw)) {
    return digits.length >= 6 && digits.length <= 15 ? `+${digits}` : null;
  }
  if (/^\+?\d+$/.test(raw)) {
    return digits.length >= 6 && digits.length <= 15 ? `+${digits}` : null;
  }
  return null;
};

const normalizeWhatsAppDirectoryPeers = (
  peers: WhatsAppDirectoryPeer[] | unknown[],
): NormalizedWhatsAppDirectoryPeer[] => {
  const dedup = new Map<string, NormalizedWhatsAppDirectoryPeer>();
  for (const peer of peers) {
    const record = isRecord(peer) ? peer : null;
    const id = normalizeWhatsAppDirectoryPeerId(record?.id);
    if (!id) {
      continue;
    }
    const name = normalizeDirectoryPeerText(record?.name) ?? undefined;
    const handle = normalizeDirectoryPeerText(record?.handle) ?? undefined;
    const accountId = normalizeDirectoryPeerText(record?.accountId) ?? undefined;
    const existing = dedup.get(id);
    if (!existing) {
      dedup.set(id, { id, name, handle, accountId });
      continue;
    }
    dedup.set(id, {
      id,
      name: existing.name ?? name,
      handle: existing.handle ?? handle,
      accountId: existing.accountId ?? accountId,
    });
  }
  return Array.from(dedup.values()).sort((a, b) => a.id.localeCompare(b.id));
};

const buildHostOrigin = (hostHeader: string | null | undefined, protocol: "http" | "https") => {
  const trimmed = hostHeader?.trim();
  if (!trimmed) {
    return null;
  }
  return normalizeOrigin(`${protocol}://${trimmed}`);
};

const ensureGatewayControlUiConfig = async (
  authDirPath: string,
  originHints: Array<string | null | undefined>,
): Promise<{ token: string | null; changed: boolean }> => {
  try {
    const configPath = path.join(authDirPath, "openclaw.json");
    const raw = await fs.readFile(configPath, "utf-8");
    const parsedUnknown = JSON.parse(raw) as unknown;
    if (!isRecord(parsedUnknown)) {
      return { token: null, changed: false };
    }
    const parsed = parsedUnknown;

    let changed = false;
    let gateway = isRecord(parsed.gateway) ? parsed.gateway : null;
    if (!gateway) {
      gateway = {};
      parsed.gateway = gateway;
      changed = true;
    }
    let auth = isRecord(gateway.auth) ? gateway.auth : null;
    if (!auth) {
      auth = {};
      gateway.auth = auth;
      changed = true;
    }
    const tokenValue = typeof auth.token === "string" && auth.token.trim() ? auth.token.trim() : null;

    let controlUi = isRecord(gateway.controlUi) ? gateway.controlUi : null;
    if (!controlUi) {
      controlUi = {};
      gateway.controlUi = controlUi;
      changed = true;
    }

    if (controlUi.allowInsecureAuth !== true) {
      controlUi.allowInsecureAuth = true;
      changed = true;
    }

    const existingOrigins = Array.isArray(controlUi.allowedOrigins)
      ? controlUi.allowedOrigins.map((value) =>
          typeof value === "string" ? normalizeOrigin(value) : null,
        )
      : [];
    const normalizedExisting = existingOrigins.filter((value): value is string => Boolean(value));
    const nextOrigins = new Set<string>();
    for (const origin of normalizedExisting) {
      nextOrigins.add(origin);
    }
    for (const origin of resolveDefaultControlUiAllowedOrigins()) {
      nextOrigins.add(origin);
    }
    for (const hint of originHints) {
      const normalized = normalizeOrigin(hint);
      if (normalized) {
        nextOrigins.add(normalized);
      }
    }
    const nextAllowedOrigins = Array.from(nextOrigins);
    const originsChanged =
      normalizedExisting.length !== nextAllowedOrigins.length ||
      normalizedExisting.some((value, index) => value !== nextAllowedOrigins[index]);
    if (originsChanged) {
      controlUi.allowedOrigins = nextAllowedOrigins;
      changed = true;
    }

    if (changed) {
      await fs.writeFile(configPath, JSON.stringify(parsed, null, 2), "utf-8");
    }
    return { token: tokenValue, changed };
  } catch {
    return { token: null, changed: false };
  }
};

const sameStringArray = (left: string[], right: string[]) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const detectGatewayConfigDrift = async (
  authDirPath: string,
  whatsappId: string,
  modelTier: ModelTier | undefined,
  directoryPeers: WhatsAppDirectoryPeer[] = [],
): Promise<{ drifted: boolean; reasons: string[] }> => {
  const reasons: string[] = [];
  try {
    const configPath = path.join(authDirPath, "openclaw.json");
    const raw = await fs.readFile(configPath, "utf-8");
    const parsedUnknown = JSON.parse(raw) as unknown;
    if (!isRecord(parsedUnknown)) {
      return { drifted: true, reasons: ["config not an object"] };
    }
    const parsed = parsedUnknown;
    const targetPrimaryModel = resolvePrimaryModelForTier(modelTier);
    const targetFallbackModels = resolveModelFallbacksForTier(modelTier);
    const targetContextTokens = resolveContextTokensForTier(modelTier);
    const agents = isRecord(parsed.agents) ? parsed.agents : null;
    const defaults = isRecord(agents?.defaults) ? agents?.defaults : null;
    const currentWorkspace =
      typeof defaults?.workspace === "string" && defaults.workspace.trim().length > 0
        ? defaults.workspace.trim()
        : null;
    if (currentWorkspace !== DEFAULT_GATEWAY_ROOT_DIR) {
      reasons.push(`agents.defaults.workspace mismatch: ${String(currentWorkspace)}`);
    }
    const currentContextTokens =
      typeof defaults?.contextTokens === "number" && Number.isFinite(defaults.contextTokens)
        ? Math.floor(defaults.contextTokens)
        : null;
    if (currentContextTokens !== targetContextTokens) {
      reasons.push(`agents.defaults.contextTokens mismatch: ${String(currentContextTokens)}`);
    }
    const model = isRecord(defaults?.model) ? defaults?.model : null;
    const currentPrimaryModel =
      typeof model?.primary === "string" && model.primary.trim().length > 0
        ? model.primary.trim()
        : null;
    if (currentPrimaryModel !== targetPrimaryModel) {
      reasons.push(`agents.defaults.model.primary mismatch: ${String(currentPrimaryModel)}`);
    }

    const currentFallbackModels = Array.isArray(model?.fallbacks)
      ? model.fallbacks
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value) => value.length > 0)
      : [];
    if (!sameStringArray(currentFallbackModels, targetFallbackModels)) {
      reasons.push("agents.defaults.model.fallbacks mismatch");
    }

    const tools = isRecord(parsed.tools) ? parsed.tools : null;
    const currentToolsProfile =
      typeof tools?.profile === "string" && tools.profile.trim().length > 0
        ? tools.profile.trim()
        : null;
    if (currentToolsProfile !== DEFAULT_TOOLS_PROFILE) {
      reasons.push(`tools.profile mismatch: ${String(currentToolsProfile)}`);
    }
    const currentAlsoAllow = Array.isArray(tools?.alsoAllow)
      ? tools.alsoAllow
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value) => value.length > 0)
      : [];
    for (const toolName of DEFAULT_TOOLS_ALSO_ALLOW) {
      if (!currentAlsoAllow.includes(toolName)) {
        reasons.push(`tools.alsoAllow missing: ${toolName}`);
      }
    }

    const browser = isRecord(parsed.browser) ? parsed.browser : null;
    if (browser?.enabled !== DEFAULT_BROWSER_ENABLED) {
      reasons.push(`browser.enabled mismatch: ${String(browser?.enabled)}`);
    }
    const currentDefaultProfile =
      typeof browser?.defaultProfile === "string" && browser.defaultProfile.trim().length > 0
        ? browser.defaultProfile.trim()
        : null;
    if (currentDefaultProfile !== DEFAULT_BROWSER_DEFAULT_PROFILE) {
      reasons.push(`browser.defaultProfile mismatch: ${String(currentDefaultProfile)}`);
    }
    if (browser?.headless !== DEFAULT_BROWSER_HEADLESS) {
      reasons.push(`browser.headless mismatch: ${String(browser?.headless)}`);
    }
    if (browser?.noSandbox !== DEFAULT_BROWSER_NO_SANDBOX) {
      reasons.push(`browser.noSandbox mismatch: ${String(browser?.noSandbox)}`);
    }

    const channels = isRecord(parsed.channels) ? parsed.channels : null;
    const whatsapp = isRecord(channels?.whatsapp) ? channels?.whatsapp : null;
    const currentDmPolicy =
      typeof whatsapp?.dmPolicy === "string" && whatsapp.dmPolicy.trim().length > 0
        ? whatsapp.dmPolicy.trim()
        : null;
    if (currentDmPolicy !== "allowlist") {
      reasons.push(`channels.whatsapp.dmPolicy mismatch: ${String(currentDmPolicy)}`);
    }
    if (whatsapp?.selfChatMode !== true) {
      reasons.push(`channels.whatsapp.selfChatMode mismatch: ${String(whatsapp?.selfChatMode)}`);
    }
    const currentAllowFrom = Array.isArray(whatsapp?.allowFrom)
      ? whatsapp.allowFrom
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value) => value.length > 0)
      : [];
    if (!sameStringArray(currentAllowFrom, [whatsappId])) {
      reasons.push(`channels.whatsapp.allowFrom mismatch: [${currentAllowFrom.join(", ")}]`);
    }

    const accounts = isRecord(whatsapp?.accounts) ? whatsapp?.accounts : null;
    const defaultAccount = isRecord(accounts?.default) ? accounts?.default : null;
    const currentAuthDir =
      typeof defaultAccount?.authDir === "string" && defaultAccount.authDir.trim().length > 0
        ? defaultAccount.authDir.trim()
        : null;
    if (currentAuthDir !== DEFAULT_GATEWAY_WHATSAPP_AUTH_DIR) {
      reasons.push(`channels.whatsapp.accounts.default.authDir mismatch: ${String(currentAuthDir)}`);
    }

    const targetDirectoryPeers = normalizeWhatsAppDirectoryPeers(directoryPeers);
    const currentDirectoryPeers = Array.isArray(whatsapp?.directoryPeers)
      ? normalizeWhatsAppDirectoryPeers(whatsapp.directoryPeers)
      : [];
    const directoryPeersDiffer =
      currentDirectoryPeers.length !== targetDirectoryPeers.length ||
      currentDirectoryPeers.some((peer, index) => {
        const target = targetDirectoryPeers[index];
        return (
          peer.id !== target?.id ||
          (peer.name ?? null) !== (target?.name ?? null) ||
          (peer.handle ?? null) !== (target?.handle ?? null) ||
          (peer.accountId ?? null) !== (target?.accountId ?? null)
        );
      });
    if (directoryPeersDiffer) {
      reasons.push("channels.whatsapp.directoryPeers mismatch");
    }

    const plugins = isRecord(parsed.plugins) ? parsed.plugins : null;
    const pluginLoad = isRecord(plugins?.load) ? plugins?.load : null;
    const currentPluginPaths = Array.isArray(pluginLoad?.paths)
      ? pluginLoad.paths
          .map((value) => (typeof value === "string" ? value.trim() : ""))
          .filter((value) => value.length > 0)
      : [];
    if (!currentPluginPaths.includes(DEFAULT_GATEWAY_ROOT_DIR)) {
      reasons.push(`plugins.load.paths missing ${DEFAULT_GATEWAY_ROOT_DIR}`);
    }
    const pluginEntries = isRecord(plugins?.entries) ? plugins?.entries : null;
    const whatsappEntry = isRecord(pluginEntries?.whatsapp) ? pluginEntries?.whatsapp : null;
    const clawdlyProfileEntry =
      isRecord(pluginEntries?.["clawdly-profile"]) ? pluginEntries?.["clawdly-profile"] : null;
    if (whatsappEntry?.enabled !== true) {
      reasons.push("plugins.entries.whatsapp.enabled must be true");
    }
    if (clawdlyProfileEntry?.enabled !== true) {
      reasons.push("plugins.entries.clawdly-profile.enabled must be true");
    }

    return { drifted: reasons.length > 0, reasons };
  } catch {
    return { drifted: true, reasons: ["config unreadable or invalid JSON"] };
  }
};

const detectGatewayRuntimeDrift = (
  runtime: Awaited<ReturnType<Provisioner["getRuntimeFingerprint"]>>,
  gateway: GatewayInstanceRecord,
) => {
  const reasons: string[] = [];
  if (gateway.configVersion !== runtime.configVersion) {
    reasons.push(`configVersion mismatch: ${gateway.configVersion} != ${runtime.configVersion}`);
  }
  if (gateway.pluginVersion !== runtime.pluginVersion) {
    reasons.push(`pluginVersion mismatch: ${gateway.pluginVersion} != ${runtime.pluginVersion}`);
  }
  if (gateway.runtimePolicyVersion !== runtime.runtimePolicyVersion) {
    reasons.push(
      `runtimePolicyVersion mismatch: ${gateway.runtimePolicyVersion} != ${runtime.runtimePolicyVersion}`,
    );
  }
  if (gateway.imageRef !== runtime.imageRef) {
    reasons.push(`imageRef mismatch: ${gateway.imageRef} != ${runtime.imageRef}`);
  }
  return reasons;
};

const parseAdminProxyUrl = (rawUrl: string | undefined) => {
  if (!rawUrl) {
    return null;
  }
  const parsed = new URL(rawUrl, "http://localhost");
  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments[0] !== "admin" || segments[1] !== "openclaw" || !segments[2]) {
    return null;
  }
  const userId = decodeURIComponent(segments[2]);
  if (!userId) {
    return null;
  }
  const suffixPath = `/${segments.slice(3).join("/")}`;
  const targetPath = `${suffixPath === "/" ? "/" : suffixPath}${parsed.search}`;
  return { userId, targetPath };
};

const writeUpgradeJsonError = (
  socket: NodeJS.WritableStream & { destroy: () => void; writableEnded?: boolean },
  statusCode: number,
  body: unknown,
) => {
  const payload = JSON.stringify(body);
  const statusText = STATUS_CODES[statusCode] ?? "Error";
  if (socket.writableEnded) {
    return;
  }
  socket.write(
    `HTTP/1.1 ${statusCode} ${statusText}\r\n` +
      "Content-Type: application/json; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
      "Connection: close\r\n" +
      "\r\n" +
      payload,
  );
  socket.destroy();
};

const start = async () => {
  const pool = await initDatabase();
  const store = createStore(pool);
  const events = new SessionEvents();
  const provisioner: Provisioner =
    deployConfig.provisioner === "docker"
      ? new DockerProvisioner(store)
      : new NoopProvisioner(store);
  const isDocker = provisioner instanceof DockerProvisioner;

  // Startup reconciliation: sync DB with actual Docker state
  if (isDocker) {
    try {
      await provisioner.reconcile();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("Reconciliation failed:", err);
    }
  }

  const ensureGatewayDesiredState = async (params: {
    caller: string;
    gateway: GatewayInstanceRecord;
    whatsappId: string;
    modelTier: ModelTier | undefined;
    runtime?: Awaited<ReturnType<Provisioner["getRuntimeFingerprint"]>>;
  }) => {
    const runtime = params.runtime ?? await provisioner.getRuntimeFingerprint();
    const directoryPeers = buildWhatsAppDirectoryPeers(
      await store.getProfileData(params.gateway.userId),
      { excludeIds: [params.whatsappId] },
    );
    const configDrift = await detectGatewayConfigDrift(
      params.gateway.authDirPath,
      params.whatsappId,
      params.modelTier,
      directoryPeers,
    );
    const runtimeDrift = detectGatewayRuntimeDrift(runtime, params.gateway);
    const reasons = [...runtimeDrift, ...configDrift.reasons];
    if (reasons.length === 0) {
      return { reprovisioned: false, reasons };
    }
    // eslint-disable-next-line no-console
    console.log(
      `[gateway-rollout] reprovision caller=${params.caller} userId=${params.gateway.userId} reasons=${reasons.join(" | ")}`,
    );
    await provisioner.provision(
      params.gateway.userId,
      params.gateway.authDirPath,
      params.whatsappId,
      { modelTier: params.modelTier },
    );
    return { reprovisioned: true, reasons };
  };

  let gatewayRolloutRunning = false;
  const runGatewayRolloutSweep = async (caller: string) => {
    if (gatewayRolloutRunning) {
      return;
    }
    gatewayRolloutRunning = true;
    try {
      const [runtime, gateways, users, agents] = await Promise.all([
        provisioner.getRuntimeFingerprint(),
        store.listGatewayInstances(),
        store.listUsers(),
        store.listAgents(),
      ]);
      const usersById = new Map(users.map((user) => [user.id, user]));
      const agentsByUserId = new Map(agents.map((agent) => [agent.userId, agent]));
      for (const gateway of gateways) {
        const user = usersById.get(gateway.userId);
        if (!user?.whatsappId) {
          continue;
        }
        const agent = agentsByUserId.get(gateway.userId);
        try {
          await ensureGatewayDesiredState({
            caller,
            gateway,
            whatsappId: user.whatsappId,
            modelTier: agent?.modelTier,
            runtime,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[gateway-rollout] failed caller=${caller} userId=${gateway.userId}:`, err);
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[gateway-rollout] sweep failed caller=${caller}:`, err);
    } finally {
      gatewayRolloutRunning = false;
    }
  };
  void runGatewayRolloutSweep("startup");
  const gatewayRolloutInterval = setInterval(
    () => void runGatewayRolloutSweep("interval"),
    deployConfig.gatewayReconcileIntervalMs,
  );

  // Periodic cleanup: purge expired sessions + stale temp dirs
  const runReaper = async () => {
    try {
      const deleted = await store.deleteExpiredLoginSessions(new Date());
      if (deleted > 0) {
        // eslint-disable-next-line no-console
        console.log(`Reaper: purged ${deleted} expired login sessions.`);
      }
      const tmpDir = path.join(deployConfig.authRoot, "tmp");
      const entries = await fs.readdir(tmpDir).catch(() => [] as string[]);
      const now = Date.now();
      for (const entry of entries) {
        const entryPath = path.join(tmpDir, entry);
        const stat = await fs.stat(entryPath).catch(() => null);
        if (stat && now - stat.mtimeMs > deployConfig.reaperMaxAgeMs) {
          await fs.rm(entryPath, { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("Reaper error:", err);
    }
  };
  void runReaper();
  const reaperInterval = setInterval(() => void runReaper(), deployConfig.reaperIntervalMs);

  const activeSessions = new Map<string, Promise<void>>();
  const sessionUsers = new Map<string, string>();
  const baseUrl = resolveBaseUrl(deployConfig.port);
  const adminToken = deployConfig.adminToken.trim();

  // ---------------------------------------------------------------------------
  // Profile/memory projection state
  //
  // - Canonical data source: raw sync payloads + append-only message events.
  // - Event path: debounce durable profile-note extraction.
  // - Scheduled path: periodic conversation-summary sweep for updated peers.
  // ---------------------------------------------------------------------------
  const PROFILE_INCREMENTAL_DEBOUNCE_MS = 20 * 1000; // 20 seconds
  const PROFILE_SWEEP_INTERVAL_MS = deployConfig.profileProjectionIntervalMs;

  const profileIncrementalTimers = new Map<string, NodeJS.Timeout>();

  const maybeProjectUserProfile = async (
    userId: string,
    whatsappId: string,
    authDirPath: string,
    caller: string,
  ) => {
    const profileData = await store.getProfileData(userId);
    const hasProjectedProfile = Boolean(profileData?.profileMd && profileData.profileMd.trim().length > 0);
    const rawUpdatedAt = profileData?.rawUpdatedAt?.getTime() ?? 0;
    const profileUpdatedAt = profileData?.profileUpdatedAt?.getTime() ?? 0;
    if (!hasProjectedProfile || rawUpdatedAt > profileUpdatedAt) {
      await projectUserProfile(userId, whatsappId, authDirPath, store, caller);
    }
  };

  const scheduleIncrementalProfileUpdate = (userId: string, authDirPath: string) => {
    const existing = profileIncrementalTimers.get(userId);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      profileIncrementalTimers.delete(userId);
      void (async () => {
        try {
          await runIncrementalProfileUpdate({
            userId,
            authDir: authDirPath,
            store,
          });
        } catch (err) {
          console.warn(`Incremental profile update failed for ${userId}:`, err);
        }
      })();
    }, PROFILE_INCREMENTAL_DEBOUNCE_MS);
    profileIncrementalTimers.set(userId, timer);
  };

  const runProfileProjectionSweep = async () => {
    const users = await store.listUsers();
    for (const user of users) {
      const gateway = await store.getGatewayInstanceByUserId(user.id);
      const authDirPath = gateway?.authDirPath ?? path.join(deployConfig.authRoot, user.id);
      try {
        await maybeProjectUserProfile(user.id, user.whatsappId, authDirPath, "periodic-sweep");
      } catch (err) {
        console.warn(`Profile projection sweep failed for ${user.id}:`, err);
      }
      try {
        await runConversationSummarySweep({
          userId: user.id,
          authDir: authDirPath,
          store,
        });
      } catch (err) {
        console.warn(`Conversation summary sweep failed for ${user.id}:`, err);
      }
    }
  };

  void runProfileProjectionSweep();
  const profileSweepInterval = setInterval(
    () => void runProfileProjectionSweep(),
    PROFILE_SWEEP_INTERVAL_MS,
  );

  const recordProfileEvent = (userId: string, authDirPath: string) => {
    scheduleIncrementalProfileUpdate(userId, authDirPath);
  };

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
    if (!isDocker) {
      return null;
    }
    return (provisioner as DockerProvisioner).inspectRuntime(containerId);
  };

  const waitForGatewayRuntime = async (containerId: string, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const runtime = await inspectGatewayRuntime(containerId);
      if (runtime?.running && runtime.ip) {
        return runtime;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return null;
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
          onProfileDataReady: (userId) => {
            void (async () => {
              try {
                const users = await store.listUsers();
                const user = users.find((item) => item.id === userId);
                if (!user) {
                  return;
                }
                const projectedAuthDir = path.join(deployConfig.authRoot, userId);
                await projectUserProfile(
                  userId,
                  user.whatsappId,
                  projectedAuthDir,
                  store,
                  "login-worker-raw-ready",
                );
              } catch (err) {
                console.warn(`Early profile projection failed for ${userId}:`, err);
              }
            })();
          },
        });
        const linked = await store.getLoginSession(sessionId);
        if (!linked || linked.state !== "linked" || !linked.userId || !linked.whatsappId) {
          return;
        }
        const linkedUserId = linked.userId;
        const linkedWhatsappId = linked.whatsappId;

        sessionUsers.set(sessionId, linkedUserId);
        await store.updateLoginSession(sessionId, { state: "deploying" });
        events.emit(sessionId, {
          type: "status",
          state: "deploying",
          message: "Provisioning your gateway...",
        });

        const existingAgent = await store.getAgentByUserId(linkedUserId);
        const agentSettings =
          existingAgent ?? (await store.createAgentForUser(linkedUserId, defaultAgentSettings()));

        // Move WA session data to the user's permanent directory
        const userAuthDir = path.join(deployConfig.authRoot, linkedUserId);
        const permanentWaDir = path.join(userAuthDir, "wa-session-data");
        await fs.mkdir(permanentWaDir, { recursive: true });
        // Copy session auth files from the temp session dir to the user's dir
        const tempWaDir = authDir;
        try {
          const files = await fs.readdir(tempWaDir);
          for (const file of files) {
            const src = path.join(tempWaDir, file);
            const dest = path.join(permanentWaDir, file);
            await fs.copyFile(src, dest);
          }
        } catch {
          // temp dir might not have any files yet
        }

        // Run profile projection and provisioning in parallel. Projection is
        // deterministic and fast, but we still avoid blocking readiness on it.
        const projectionPromise = projectUserProfile(
          linkedUserId,
          linkedWhatsappId,
          userAuthDir,
          store,
          "login-flow",
        ).catch((err) => {
          console.warn(`Initial profile projection failed for ${linkedUserId}:`, err);
        });

        const result = await provisioner.provision(
          linkedUserId,
          userAuthDir,
          linkedWhatsappId,
          { modelTier: agentSettings.modelTier },
        );

        // Let projection finish in the background — don't block the "ready" event.
        void projectionPromise;

        if (!result.healthy) {
          throw new Error("Gateway container failed to start.");
        }

        await store.updateLoginSession(sessionId, { state: "ready" });

        // After a fresh QR registration, the phone uploads its chat history to WA
        // servers in the background (takes 1–5 min). Once uploaded, WA delivers
        // messaging-history.set to the running gateway. We schedule a deferred
        // reprovision to capture that data and re-project the profile.
        const profileAtLogin = await store.getProfileData(linkedUserId);
        const contactsAtLogin = (() => {
          try { return JSON.parse(profileAtLogin?.contactsJson ?? "[]"); } catch { return []; }
        })();
        if (!Array.isArray(contactsAtLogin) || contactsAtLogin.length === 0) {
          const DEFERRED_MS = 3 * 60 * 1000;
          // eslint-disable-next-line no-console
          console.log(`[login-flow] no WA contacts captured — scheduling deferred sync in ${DEFERRED_MS / 1000}s for userId=${linkedUserId}`);
          setTimeout(() => {
            void (async () => {
              try {
                const current = await store.getProfileData(linkedUserId);
                const currentContacts = (() => {
                  try { return JSON.parse(current?.contactsJson ?? "[]"); } catch { return []; }
                })();
                if (Array.isArray(currentContacts) && currentContacts.length > 0) {
                  // eslint-disable-next-line no-console
                  console.log(`[login-flow] deferred sync skipped — contacts already present for userId=${linkedUserId}`);
                  return;
                }
                // eslint-disable-next-line no-console
                console.log(`[login-flow] deferred sync starting for userId=${linkedUserId}`);
                await provisioner.deprovision(linkedUserId);
                const deferred = await collectWhatsAppSyncData(permanentWaDir, 60_000);
                if (deferred.contacts.length > 0 || deferred.chats.length > 0) {
                  await store.upsertRawProfileData(linkedUserId, deferred);
                  await projectUserProfile(linkedUserId, linkedWhatsappId, userAuthDir, store, "deferred-login-sync");
                  // eslint-disable-next-line no-console
                  console.log(`[login-flow] deferred sync complete — contacts=${deferred.contacts.length} chats=${deferred.chats.length} for userId=${linkedUserId}`);
                } else {
                  // eslint-disable-next-line no-console
                  console.warn(`[login-flow] deferred sync: still no WA data for userId=${linkedUserId} — phone may not have finished uploading yet`);
                }
              } catch (err) {
                // eslint-disable-next-line no-console
                console.warn(`[login-flow] deferred sync failed for userId=${linkedUserId}:`, err);
              } finally {
                // Always restart the gateway whether sync succeeded or not
                try {
                  await provisioner.provision(linkedUserId, userAuthDir, linkedWhatsappId, { modelTier: agentSettings.modelTier });
                } catch (err) {
                  // eslint-disable-next-line no-console
                  console.warn(`[login-flow] deferred sync: failed to reprovision userId=${linkedUserId}:`, err);
                }
              }
            })();
          }, DEFERRED_MS);
        }

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

  const closeUserSessions = async (userId: string) => {
    const sessions = await store.listLoginSessions();
    let closed = 0;
    for (const session of sessions) {
      if (session.userId !== userId) {
        continue;
      }
      if (session.state === "expired" || session.state === "error") {
        continue;
      }
      const updated = await store.updateLoginSession(session.id, {
        state: "expired",
        errorCode: "SESSION_EXPIRED",
        errorMessage: "Session closed by admin.",
      });
      if (!updated) {
        continue;
      }
      closed += 1;
      sessionUsers.delete(session.id);
      events.emit(session.id, {
        type: "status",
        state: "expired",
        message: "Session closed by admin.",
      });
    }
    return closed;
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

    // Inspect live status from Docker for each gateway
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
              gatewayToken: gateway.gatewayToken || null,
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
        gatewayToken: gateway.gatewayToken || null,
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

  app.post("/v1/admin/users/:userId/deprovision", requireAdmin, async (req, res) => {
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    if (!userId) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }

    try {
      const sessionsClosed = await closeUserSessions(userId);
      await provisioner.deprovision(userId);

      res.json({
        ok: true,
        userId,
        sessionsClosed,
      });
    } catch {
      res.status(500).json({ error: "deprovision_failed" });
    }
  });

  app.post("/v1/admin/users/:userId/reset-wa-session", requireAdmin, async (req, res) => {
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    if (!userId) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }

    try {
      const users = await store.listUsers();
      const user = users.find((u) => u.id === userId);
      if (!user) {
        res.status(404).json({ error: "user_not_found" });
        return;
      }

      const gateway = await store.getGatewayInstanceByUserId(userId);
      const authDir = gateway?.authDirPath || path.join(deployConfig.authRoot, userId);
      const waAuthDir = path.join(authDir, "wa-session-data");

      // Stop the gateway and close all login sessions
      const sessionsClosed = await closeUserSessions(userId);
      await provisioner.deprovision(userId);

      // Wipe the WA session credentials so the next login starts fresh,
      // triggering a full Baileys sync (contacts, chats, messages).
      try {
        await fs.rm(waAuthDir, { recursive: true, force: true });
        // eslint-disable-next-line no-console
        console.log(`[reset-wa] wiped ${waAuthDir} for userId=${userId}`);
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[reset-wa] could not wipe waAuthDir for userId=${userId}:`, err);
      }

      res.json({ ok: true, userId, sessionsClosed });
    } catch {
      res.status(500).json({ error: "reset_failed" });
    }
  });

  app.get("/v1/admin/users/:userId/profile", requireAdmin, async (req, res) => {
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    if (!userId) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    try {
      const profileData = await store.getProfileData(userId);

      // Parse raw WA data into lightweight summaries for the admin UI.
      const parseNames = (json: string | null): string[] => {
        if (!json) return [];
        try {
          const arr = JSON.parse(json);
          if (!Array.isArray(arr)) return [];
          return arr
            .map((item: Record<string, unknown>) =>
              String(item?.name ?? item?.notify ?? item?.verifiedName ?? "").trim(),
            )
            .filter(Boolean);
        } catch { return []; }
      };

      const parseMessages = (json: string | null): Array<{ role: string; text: string }> => {
        if (!json) return [];
        try {
          const arr = JSON.parse(json);
          if (!Array.isArray(arr)) return [];
          const out: Array<{ role: string; text: string }> = [];
          for (const msg of arr) {
            const m = msg as Record<string, unknown>;
            const inner = m.message as Record<string, unknown> | undefined;
            if (!inner) continue;
            const text =
              typeof inner.conversation === "string"
                ? inner.conversation
                : typeof (inner.extendedTextMessage as Record<string, unknown> | undefined)?.text === "string"
                  ? String((inner.extendedTextMessage as Record<string, unknown>).text)
                  : null;
            if (!text?.trim()) continue;
            const key = m.key as Record<string, unknown> | undefined;
            const role = key?.fromMe === true ? "me" : "them";
            out.push({ role, text: text.trim().slice(0, 300) });
            if (out.length >= 100) break;
          }
          return out;
        } catch { return []; }
      };

      const contacts = parseNames(profileData?.contactsJson ?? null);
      const chats = parseNames(profileData?.chatsJson ?? null);
      const messages = parseMessages(profileData?.messagesJson ?? null);

      res.json({
        userId,
        profileMd: profileData?.profileMd ?? null,
        displayName: profileData?.displayName ?? null,
        updatedAt: profileData?.profileUpdatedAt ?? null,
        rawData: profileData
          ? {
              capturedAt: profileData.rawUpdatedAt,
              displayName: profileData.displayName,
              contacts: { count: contacts.length, names: contacts },
              chats: { count: chats.length, names: chats },
              messages: { count: messages.length, items: messages },
            }
          : null,
      });
    } catch {
      res.status(500).json({ error: "profile_fetch_failed" });
    }
  });

  // Re-run deterministic profile projection from raw WhatsApp data already in DB.
  app.post("/v1/admin/users/:userId/resynthesize", requireAdmin, async (req, res) => {
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    if (!userId) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }
    try {
      const users = await store.listUsers();
      const user = users.find((u) => u.id === userId);
      if (!user) {
        res.status(404).json({ error: "user_not_found" });
        return;
      }
      const authDir = path.join(deployConfig.authRoot, userId);
      await projectUserProfile(userId, user.whatsappId ?? "", authDir, store, "admin-reproject");
      res.json({ ok: true });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[reproject] failed for userId=${userId}:`, err);
      res.status(500).json({ error: "resynthesize_failed" });
    }
  });

  app.post("/v1/admin/users/:userId/reprovision", requireAdmin, async (req, res) => {
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    if (!userId) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }

    try {
      // Look up user and their existing gateway/agent
      const users = await store.listUsers();
      const user = users.find((u) => u.id === userId);
      if (!user) {
        res.status(404).json({ error: "user_not_found" });
        return;
      }

      const agent = await store.getAgentByUserId(userId);
      const gateway = await store.getGatewayInstanceByUserId(userId);
      const authDir = gateway?.authDirPath || path.join(deployConfig.authRoot, userId);
      const waAuthDir = path.join(authDir, "wa-session-data");

      // Step 1: Stop the running gateway so we can briefly reconnect to WhatsApp
      // and collect fresh sync data (contacts, chats, messages). This avoids a
      // dual-connection conflict that would kick out the running container.
      // eslint-disable-next-line no-console
      console.log(`[reprovision] deprovisioning userId=${userId} before WhatsApp sync`);
      await provisioner.deprovision(userId);

      // Step 2: Collect WhatsApp sync data — only if valid credentials exist.
      // Skip entirely when wa-session-data is absent or was wiped (e.g. after
      // reset-wa-session). Without this guard Baileys would silently register
      // a new device without a QR scan, defeating the purpose of the reset.
      const credsPath = path.join(waAuthDir, "creds.json");
      const hasCredentials = await fs.access(credsPath).then(() => true).catch(() => false);
      if (hasCredentials) {
        try {
          // eslint-disable-next-line no-console
          console.log(`[reprovision] collecting WhatsApp sync data for userId=${userId}`);
          const syncData = await collectWhatsAppSyncData(waAuthDir, 60_000);
          if (syncData.contacts.length > 0 || syncData.chats.length > 0 || syncData.messages.length > 0 || syncData.displayName) {
            await store.upsertRawProfileData(userId, syncData);
            // eslint-disable-next-line no-console
            console.log(`[reprovision] stored sync data for userId=${userId}`);
          } else {
            // eslint-disable-next-line no-console
            console.warn(`[reprovision] WhatsApp sync returned no data for userId=${userId}`);
          }
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[reprovision] WhatsApp sync failed for userId=${userId}:`, err);
        }
      } else {
        // eslint-disable-next-line no-console
        console.log(`[reprovision] no WA credentials found — skipping sync for userId=${userId} (reset pending)`);
      }

      // Step 3: Rebuild deterministic profile projection from collected data.
      try {
        await projectUserProfile(userId, user.whatsappId, authDir, store, "reprovision");
      } catch (err) {
        // eslint-disable-next-line no-console
        console.warn(`[reprovision] profile projection failed for userId=${userId}:`, err);
      }

      // Step 4: Provision new gateway container.
      const result = await provisioner.provision(userId, authDir, user.whatsappId, {
        modelTier: agent?.modelTier,
      });

      res.json({
        ok: true,
        userId,
        healthy: result.healthy,
        gatewayId: result.instance.id,
        containerId: result.instance.containerId,
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Reprovision failed for ${userId}:`, err);
      res.status(500).json({ error: "reprovision_failed" });
    }
  });

  app.use("/admin/openclaw/:userId", requireAdmin, async (req, res) => {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).json({ error: "method_not_allowed" });
      return;
    }

    if (!isDocker) {
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

    try {
      const acceptHeader = getProxyHeaderValue(req.headers.accept);
      const hostOrigin = buildHostOrigin(
        req.get("host"),
        req.protocol === "https" ? "https" : "http",
      );
      const configState = await ensureGatewayControlUiConfig(gateway.authDirPath, [
        req.header("origin"),
        hostOrigin,
      ]);
      if (configState.changed) {
        await provisioner.restartContainer(userId);
      }
      const runtime = configState.changed
        ? await waitForGatewayRuntime(gateway.containerId)
        : await inspectGatewayRuntime(gateway.containerId);
      if (!runtime?.running || !runtime.ip) {
        res.status(503).json({ error: "gateway_not_running" });
        return;
      }

      const requestedPath = req.url && req.url.length > 0 ? req.url : "/";
      const targetUrl = `http://${runtime.ip}:18789${requestedPath.startsWith("/") ? requestedPath : `/${requestedPath}`}`;
      const headers: Record<string, string> = {};
      if (acceptHeader) {
        headers.accept = acceptHeader;
      }
      if (configState.token) {
        headers.authorization = `Bearer ${configState.token}`;
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

  // ---------------------------------------------------------------------------
  // Internal profile events — called by the OpenClaw plugin running inside
  // each user's gateway container. Authenticated via the per-user gateway token.
  // ---------------------------------------------------------------------------
  app.post("/v1/internal/profile-events/:userId", async (req, res) => {
    const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
    if (!userId) {
      res.status(400).json({ error: "invalid_user_id" });
      return;
    }

    // Validate using the gateway token stored in the DB
    const authHeader = req.header("authorization");
    const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
    if (!bearerToken) {
      res.status(401).json({ error: "missing_token" });
      return;
    }
    const gateway = await store.getGatewayInstanceByUserId(userId);
    if (!gateway || !gateway.gatewayToken || gateway.gatewayToken !== bearerToken) {
      res.status(401).json({ error: "invalid_token" });
      return;
    }

    const body = req.body ?? {};
    const eventType = typeof body.type === "string" ? body.type : "message";
    const content = typeof body.content === "string" ? body.content : "";
    const channel = typeof body.channel === "string" && body.channel.trim().length > 0
      ? body.channel.trim().toLowerCase()
      : "whatsapp";
    const direction = body.direction === "outbound" ? "outbound" : "inbound";
    const peerIdRaw = (() => {
      if (typeof body.peerId === "string" && body.peerId.trim().length > 0) {
        return body.peerId;
      }
      if (typeof body.from === "string" && body.from.trim().length > 0) {
        return body.from;
      }
      if (typeof body.to === "string" && body.to.trim().length > 0) {
        return body.to;
      }
      return "";
    })();
    const peerId = peerIdRaw.trim();
    const occurredAt = (() => {
      const value = body.timestamp;
      if (typeof value === "number" && Number.isFinite(value)) {
        const asMs = value > 10_000_000_000 ? value : value * 1000;
        const parsed = new Date(asMs);
        return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
      }
      if (typeof value === "string" && value.trim().length > 0) {
        const parsed = new Date(value.trim());
        return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
      }
      return new Date();
    })();
    if (eventType === "agent_note" && content.trim()) {
      // Immediately append the agent note to projected profile memory.
      try {
        await appendAgentNoteToProfile(gateway.authDirPath, content);
      } catch (err) {
        console.warn(`Failed to append agent note for ${userId}:`, err);
      }
    } else if (eventType === "message") {
      if (!peerId || !content.trim()) {
        res.json({ ok: true, skipped: "missing_peer_or_content" });
        return;
      }
      const appended = await store.appendProfileMessageEvent({
        userId,
        channel,
        peerId,
        direction,
        content: content.slice(0, 4000),
        occurredAt,
      });
      try {
        await appendConversationLogEntry(gateway.authDirPath, appended);
      } catch (err) {
        console.warn(`Failed to append conversation log for ${userId} peer=${peerId}:`, err);
      }
      recordProfileEvent(userId, gateway.authDirPath);
    }

    res.json({ ok: true });
  });

  app.post("/v1/login-sessions", async (_req, res) => {
    const expiresAt = new Date(Date.now() + deployConfig.sessionTtlMs);
    const session = createLoginSessionRecord({ authDir: "", expiresAt });
    const sessionId = session.id;
    const authDir = path.join(deployConfig.authRoot, "tmp", sessionId);
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

    // Live status from Docker (updates DB as side effect)
    const gatewayStatus = await provisioner.inspectStatus(userId);

    // Ensure gateway runtime/config/plugin versions are current
    const gateway = await store.getGatewayInstanceByUserId(userId);
    if (gateway) {
      const users = await store.listUsers();
      const user = users.find((item) => item.id === userId);
      if (user?.whatsappId) {
        await ensureGatewayDesiredState({
          caller: "v1-agent-get",
          gateway,
          whatsappId: user.whatsappId,
          modelTier: agent.modelTier,
        });
      }
    }

    const gatewayToken = gateway?.gatewayToken || null;
    res.json({
      agentId: agent.id,
      status: "running",
      modelTier: agent.modelTier,
      name: agent.name,
      tone: agent.tone,
      language: agent.language,
      allowlistOnly: agent.allowlistOnly,
      gatewayStatus,
      gatewayToken,
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
    const gateway = await store.getGatewayInstanceByUserId(userId);
    if (gateway) {
      const users = await store.listUsers();
      const user = users.find((item) => item.id === userId);
      if (user?.whatsappId) {
        await ensureGatewayDesiredState({
          caller: "v1-agent-patch",
          gateway,
          whatsappId: user.whatsappId,
          modelTier: next.modelTier,
        });
      }
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

  const server = app.listen(deployConfig.port, () => {
    // eslint-disable-next-line no-console
    console.log(`Deploy web listening on ${baseUrl}`);
  });

  server.on("upgrade", (req, socket, head) => {
    void (async () => {
      const parsed = parseAdminProxyUrl(req.url);
      if (!parsed) {
        socket.destroy();
        return;
      }

      if (isAdminDisabled()) {
        writeUpgradeJsonError(socket, 404, { error: "not_found" });
        return;
      }
      if (adminToken) {
        const candidate = getAdminTokenFromIncomingRequest(req);
        if (candidate !== adminToken) {
          writeUpgradeJsonError(socket, 401, { error: "unauthorized" });
          return;
        }
      }
      if (!isDocker) {
        writeUpgradeJsonError(socket, 400, { error: "docker_provisioner_required" });
        return;
      }

      const gateway = await store.getGatewayInstanceByUserId(parsed.userId);
      if (!gateway || !gateway.containerId) {
        writeUpgradeJsonError(socket, 404, { error: "not_found" });
        return;
      }

      const requestOrigin = getProxyHeaderValue(req.headers.origin);
      let protocolHint: "http" | "https" = "http";
      const normalizedRequestOrigin = normalizeOrigin(requestOrigin);
      if (normalizedRequestOrigin?.startsWith("https://")) {
        protocolHint = "https";
      }
      const hostOrigin = buildHostOrigin(getProxyHeaderValue(req.headers.host), protocolHint);
      const configState = await ensureGatewayControlUiConfig(gateway.authDirPath, [
        requestOrigin,
        hostOrigin,
      ]);
      if (configState.changed) {
        await provisioner.restartContainer(parsed.userId);
      }
      const runtime = configState.changed
        ? await waitForGatewayRuntime(gateway.containerId)
        : await inspectGatewayRuntime(gateway.containerId);
      if (!runtime?.running || !runtime.ip) {
        writeUpgradeJsonError(socket, 503, { error: "gateway_not_running" });
        return;
      }
      const upstreamHeaders: Record<string, string | string[]> = {};
      const originalHost = getProxyHeaderValue(req.headers.host);
      for (const [key, value] of Object.entries(req.headers)) {
        if (!value) {
          continue;
        }
        const lower = key.toLowerCase();
        if (
          lower === "host" ||
          lower === "x-admin-token" ||
          lower === "authorization" ||
          lower === "content-length"
        ) {
          continue;
        }
        upstreamHeaders[key] = value;
      }
      if (originalHost) {
        upstreamHeaders.host = originalHost;
      }
      if (configState.token) {
        upstreamHeaders.authorization = `Bearer ${configState.token}`;
      }

      let finalized = false;
      const fail = (statusCode: number, payload: unknown) => {
        if (finalized) {
          return;
        }
        finalized = true;
        writeUpgradeJsonError(socket, statusCode, payload);
      };

      const upstreamReq = httpRequest({
        host: runtime.ip,
        port: 18789,
        method: req.method ?? "GET",
        path: parsed.targetPath,
        setHost: false,
        headers: upstreamHeaders,
      });

      upstreamReq.on("upgrade", (upstreamRes, upstreamSocket, upstreamHead) => {
        if (finalized) {
          upstreamSocket.destroy();
          return;
        }
        finalized = true;
        const statusCode = upstreamRes.statusCode ?? 101;
        const statusText = upstreamRes.statusMessage ?? STATUS_CODES[statusCode] ?? "Switching Protocols";
        socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\n`);
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (!value) {
            continue;
          }
          if (Array.isArray(value)) {
            for (const entry of value) {
              socket.write(`${key}: ${entry}\r\n`);
            }
          } else {
            socket.write(`${key}: ${value}\r\n`);
          }
        }
        socket.write("\r\n");
        if (upstreamHead.length > 0) {
          socket.write(upstreamHead);
        }
        if (head.length > 0) {
          upstreamSocket.write(head);
        }
        upstreamSocket.pipe(socket);
        socket.pipe(upstreamSocket);
        upstreamSocket.on("error", () => socket.destroy());
        socket.on("error", () => upstreamSocket.destroy());
      });

      upstreamReq.on("response", async (upstreamRes) => {
        const chunks: Buffer[] = [];
        for await (const chunk of upstreamRes) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (finalized) {
          return;
        }
        finalized = true;
        const body = Buffer.concat(chunks);
        const statusCode = upstreamRes.statusCode ?? 502;
        const statusText = upstreamRes.statusMessage ?? STATUS_CODES[statusCode] ?? "Bad Gateway";
        socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\n`);
        for (const [key, value] of Object.entries(upstreamRes.headers)) {
          if (!value) {
            continue;
          }
          const lower = key.toLowerCase();
          if (
            lower === "connection" ||
            lower === "transfer-encoding" ||
            lower === "keep-alive" ||
            lower === "content-length"
          ) {
            continue;
          }
          if (Array.isArray(value)) {
            for (const entry of value) {
              socket.write(`${key}: ${entry}\r\n`);
            }
          } else {
            socket.write(`${key}: ${value}\r\n`);
          }
        }
        socket.write(`Content-Length: ${body.length}\r\n`);
        socket.write("Connection: close\r\n");
        socket.write("\r\n");
        if (body.length > 0) {
          socket.write(body);
        }
        socket.destroy();
      });

      upstreamReq.on("error", () => fail(502, { error: "upstream_unreachable" }));
      upstreamReq.end();
    })().catch(() => {
      writeUpgradeJsonError(socket, 500, { error: "proxy_failure" });
    });
  });

  const shutdown = () => {
    clearInterval(reaperInterval);
    clearInterval(gatewayRolloutInterval);
    clearInterval(profileSweepInterval);
    for (const timer of profileIncrementalTimers.values()) {
      clearTimeout(timer);
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
