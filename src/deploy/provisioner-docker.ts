import Docker from "dockerode";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { deployConfig } from "./config.js";
import type { DeployStore } from "./store.js";
import type { GatewayInstanceRecord, ModelTier } from "./types.js";
import type { ProvisionOptions, ProvisionResult, Provisioner } from "./provisioner.js";

const CONFIG_FILENAME = "openclaw.json";
const PLUGIN_FILENAME = "clawdly-profile.js";
const PLUGIN_MANIFEST_FILENAME = "openclaw.plugin.json";
const LABEL_ROLE = "clawdly.role";
const LABEL_USER = "clawdly.user";
const GATEWAY_ROLE = "gateway";
const HEALTH_POLL_INTERVAL_MS = 1_000;
const HEALTH_POLL_MAX_ATTEMPTS = 10;

const GATEWAY_ENV_PASSTHROUGH = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "OPENROUTER_API_KEY",
  "XAI_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "TOGETHER_API_KEY",
  "PERPLEXITY_API_KEY",
  "CEREBRAS_API_KEY",
  "NVIDIA_API_KEY",
] as const;

const DEFAULT_TOOLS_PROFILE = "minimal";

// ---------------------------------------------------------------------------
// Model strategy (all free options prioritised first)
//
// best/premium: Kimi K2.5 (free 671B coding champion) → Gemini Pro (free 1M ctx)
//               → Gemini Flash (free, fast) → Nemotron Ultra (free 253B)
//               → Groq 70B (free*) → GPT-4o-mini (cheap last resort)
//
// fast:         Gemini Flash (free, fast, smart 1M ctx) → Groq 8B (free*, ultra-fast)
//               → Nemotron Nano (free) → GPT-4o-mini (cheap last resort)
//
// NOTE: Groq is not a native LLM provider in OpenClaw — it is configured as a
// custom openai-completions provider below so the model IDs resolve correctly.
// ---------------------------------------------------------------------------

const MODEL_PRIMARY_BY_TIER: Record<ModelTier, string> = {
  best: "nvidia/moonshotai/kimi-k2.5",
  fast: "google/gemini-3-flash-preview",
  premium: "nvidia/moonshotai/kimi-k2.5",
};

const MODEL_FALLBACKS_BY_TIER: Record<ModelTier, string[]> = {
  best: [
    "google/gemini-3-pro-preview",
    "google/gemini-3-flash-preview",
    "nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1",
    "groq/llama-3.3-70b-versatile",
    "openai/gpt-4o-mini",
  ],
  fast: [
    "groq/llama-3.1-8b-instant",
    "nvidia/nvidia/llama-3.1-nemotron-nano-8b-v1",
    "openai/gpt-4o-mini",
  ],
  premium: [
    "google/gemini-3-pro-preview",
    "google/gemini-3-flash-preview",
    "nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1",
    "groq/llama-3.3-70b-versatile",
    "openai/gpt-4o-mini",
  ],
};

const MODEL_CONTEXT_TOKENS_BY_TIER: Record<ModelTier, number> = {
  best: 131_072,
  fast: 32_000,
  premium: 131_072,
};

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

const resolveControlUiAllowedOrigins = () => {
  const candidates = [
    deployConfig.baseUrl,
    `http://localhost:${deployConfig.port}`,
    `http://127.0.0.1:${deployConfig.port}`,
    `http://[::1]:${deployConfig.port}`,
  ];
  const unique = new Set<string>();
  for (const candidate of candidates) {
    const origin = normalizeOrigin(candidate);
    if (origin) {
      unique.add(origin);
    }
  }
  return Array.from(unique);
};

const resolvePrimaryModel = (modelTier: ModelTier | undefined) =>
  MODEL_PRIMARY_BY_TIER[modelTier ?? "best"] ?? MODEL_PRIMARY_BY_TIER.best;

const resolveModelFallbacks = (modelTier: ModelTier | undefined) =>
  [...(MODEL_FALLBACKS_BY_TIER[modelTier ?? "best"] ?? MODEL_FALLBACKS_BY_TIER.best)];

const resolveContextTokens = (modelTier: ModelTier | undefined) =>
  MODEL_CONTEXT_TOKENS_BY_TIER[modelTier ?? "best"] ?? MODEL_CONTEXT_TOKENS_BY_TIER.best;

const buildConfig = (
  authDir: string,
  whatsappId: string,
  gatewayToken: string,
  modelTier?: ModelTier,
) => ({
  gateway: {
    auth: {
      mode: "token",
      token: gatewayToken,
    },
    controlUi: {
      allowInsecureAuth: true,
      allowedOrigins: resolveControlUiAllowedOrigins(),
    },
  },
  channels: {
    whatsapp: {
      dmPolicy: "allowlist",
      allowFrom: [whatsappId],
      selfChatMode: true,
      accounts: {
        default: {
          authDir,
        },
      },
    },
  },
  plugins: {
    load: {
      paths: [authDir],
    },
    entries: {
      whatsapp: {
        enabled: true,
      },
      "clawdly-profile": {
        enabled: true,
      },
    },
  },
  models: {
    mode: "merge",
    providers: {
      // Nvidia NIM — free tier, hosts Kimi K2.5 and Nemotron family
      nvidia: {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: "${NVIDIA_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "moonshotai/kimi-k2.5",
            name: "Kimi K2.5",
            input: ["text"],
            contextWindow: 131072,
            maxTokens: 8192,
          },
          {
            id: "nvidia/llama-3.1-nemotron-ultra-253b-v1",
            name: "Nemotron Ultra 253B",
            input: ["text"],
            contextWindow: 131072,
            maxTokens: 16384,
          },
          {
            id: "nvidia/llama-3.1-nemotron-nano-8b-v1",
            name: "Nemotron Nano 8B",
            input: ["text"],
            contextWindow: 131072,
            maxTokens: 8192,
          },
        ],
      },
      // Groq — not a native LLM provider in this OpenClaw build; configured as
      // openai-completions so groq/* model IDs resolve correctly.
      groq: {
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: "${GROQ_API_KEY}",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.3-70b-versatile",
            name: "Llama 3.3 70B Versatile",
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 8192,
          },
          {
            id: "llama-3.1-8b-instant",
            name: "Llama 3.1 8B Instant",
            input: ["text"],
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    },
  },
  agents: {
    defaults: {
      // Point the workspace at the auth dir so OpenClaw reads BOOTSTRAP.md from
      // there automatically on every main-agent run (sub-agents are excluded by
      // OpenClaw's SUBAGENT_BOOTSTRAP_ALLOWLIST — only AGENTS.md and TOOLS.md).
      workspace: authDir,
      contextTokens: resolveContextTokens(modelTier),
      model: {
        primary: resolvePrimaryModel(modelTier),
        fallbacks: resolveModelFallbacks(modelTier),
      },
    },
  },
  tools: {
    profile: DEFAULT_TOOLS_PROFILE,
    alsoAllow: ["get_user_profile", "update_user_profile", "memory_search", "memory_get"],
  },
});

// ---------------------------------------------------------------------------
// Plugin source generator — writes the clawdly-profile.js plugin file into
// the user's auth directory. Config constants are injected directly so the
// plugin has no external dependency on the deploy server for its own config.
// ---------------------------------------------------------------------------

const buildPluginSource = (
  userId: string,
  gatewayToken: string,
  deployServerUrl: string,
): string => `// clawdly-profile.js
// Auto-generated by the Clawdly deploy server. Do not edit manually.
import { readFile } from "node:fs/promises";

const CLAWDLY_USER_ID = ${JSON.stringify(userId)};
const CLAWDLY_GATEWAY_TOKEN = ${JSON.stringify(gatewayToken)};
const CLAWDLY_DEPLOY_URL = ${JSON.stringify(deployServerUrl)};
const PROFILE_FILE = "/data/auth/memory/user-profile.md";

export default function register(api) {
  console.log("[clawdly-profile] plugin registered for userId=" + CLAWDLY_USER_ID);

  // Profile context is injected via BOOTSTRAP.md in the workspace directory
  // (agents.defaults.workspace = /data/auth). OpenClaw reads it automatically
  // on every main-agent run — no hook needed here.

  // Forward each inbound message to the deploy server for profile enrichment.
  // event shape: { from: string, content: string, timestamp?: number }
  api.on("message_received", async (event) => {
    if (!CLAWDLY_USER_ID || !CLAWDLY_DEPLOY_URL) return;
    const content = typeof event?.content === "string" ? event.content : "";
    console.log("[clawdly-profile] message_received: forwarding event contentLen=" + content.length);
    try {
      const resp = await fetch(
        \`\${CLAWDLY_DEPLOY_URL}/v1/internal/profile-events/\${encodeURIComponent(CLAWDLY_USER_ID)}\`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: \`Bearer \${CLAWDLY_GATEWAY_TOKEN}\`,
          },
          body: JSON.stringify({
            type: "message",
            content: content.slice(0, 4000),
            direction: "inbound",
            timestamp: new Date().toISOString(),
          }),
        },
      );
      if (!resp.ok) {
        console.warn("[clawdly-profile] message_received: deploy server returned " + resp.status);
      }
    } catch (err) {
      console.warn("[clawdly-profile] message_received: fetch failed: " + String(err));
      // Non-critical — never block the agent turn.
    }
  });

  // Tool: retrieve the current profile.
  // parameters (not inputSchema); execute returns { content: [{ type, text }] }.
  api.registerTool({
    name: "get_user_profile",
    description:
      "Retrieve everything you know about this person — profile, personality, relationships, goals, and recent context. Call this when you need to recall who you are talking to.",
    parameters: { type: "object", properties: {} },
    execute: async () => {
      try {
        const md = await readFile(PROFILE_FILE, "utf-8");
        console.log("[clawdly-profile] get_user_profile: read " + md.length + " chars");
        return { content: [{ type: "text", text: md || "Profile not yet available." }] };
      } catch (err) {
        console.warn("[clawdly-profile] get_user_profile: could not read profile: " + String(err?.code ?? err));
        return { content: [{ type: "text", text: "Profile not yet available." }] };
      }
    },
  });

  // Tool: add a fact or note to the profile.
  api.registerTool({
    name: "update_user_profile",
    description:
      "Save a new fact or note about this person so it is remembered in future conversations. Use when you learn something important.",
    parameters: {
      type: "object",
      properties: {
        note: {
          type: "string",
          description: "The fact or note to add to the user profile.",
        },
      },
      required: ["note"],
    },
    execute: async (_toolCallId, params) => {
      console.log("[clawdly-profile] update_user_profile: note=" + String(params.note).slice(0, 80));
      if (!CLAWDLY_USER_ID || !CLAWDLY_DEPLOY_URL) {
        console.warn("[clawdly-profile] update_user_profile: missing userId or deployUrl — cannot update");
        return { content: [{ type: "text", text: "Profile update not available." }] };
      }
      try {
        const resp = await fetch(
          \`\${CLAWDLY_DEPLOY_URL}/v1/internal/profile-events/\${encodeURIComponent(CLAWDLY_USER_ID)}\`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: \`Bearer \${CLAWDLY_GATEWAY_TOKEN}\`,
            },
            body: JSON.stringify({
              type: "agent_note",
              content: params.note,
              timestamp: new Date().toISOString(),
            }),
          },
        );
        console.log("[clawdly-profile] update_user_profile: deploy server responded " + resp.status);
        return {
          content: [
            {
              type: "text",
              text: resp.ok
                ? "Got it — noted for future conversations."
                : "Could not save the note right now.",
            },
          ],
        };
      } catch (err) {
        console.warn("[clawdly-profile] update_user_profile: fetch failed: " + String(err));
        return { content: [{ type: "text", text: "Could not save the note right now." }] };
      }
    },
  });
}
`;

const resolveGatewayProviderEnv = () =>
  GATEWAY_ENV_PASSTHROUGH.flatMap((name) => {
    const value = process.env[name];
    if (!value || value.trim().length === 0) {
      return [];
    }
    return [`${name}=${value}`];
  });

const chownRecursive = async (targetPath: string, uid: number, gid: number): Promise<void> => {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(targetPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  if (stat.isDirectory()) {
    const entries = await fs.readdir(targetPath);
    for (const entry of entries) {
      await chownRecursive(path.join(targetPath, entry), uid, gid);
    }
  }
  await fs.chown(targetPath, uid, gid);
};

type DockerProvisionerOptions = {
  image: string;
  network?: string;
  authVolume?: string;
  containerPrefix: string;
  gatewayUid: number;
  gatewayGid: number;
};

export class DockerProvisioner implements Provisioner {
  private docker: Docker;
  private opts: DockerProvisionerOptions;

  constructor(private store: DeployStore, opts?: Partial<DockerProvisionerOptions>) {
    this.docker = new Docker();
    this.opts = {
      image: deployConfig.dockerImage,
      network: deployConfig.dockerNetwork || undefined,
      authVolume: deployConfig.dockerAuthVolume || undefined,
      containerPrefix: deployConfig.dockerContainerPrefix,
      gatewayUid: deployConfig.dockerGatewayUid,
      gatewayGid: deployConfig.dockerGatewayGid,
      ...opts,
    };
  }

  // ---------------------------------------------------------------------------
  // provision – idempotent: re-running for the same user replaces the container
  // ---------------------------------------------------------------------------
  async provision(
    userId: string,
    authDir: string,
    whatsappId: string,
    options?: ProvisionOptions,
  ): Promise<ProvisionResult> {
    const containerName = this.resolveContainerName(userId);
    const gatewayToken = randomBytes(24).toString("hex");

    // 1. Upsert DB record
    const instance = await this.store.createGatewayInstanceForUser(userId, authDir, {
      gatewayToken,
      containerName,
    });

    // 2. Write openclaw.json config + plugin file
    const gatewayAuthDir = this.resolveGatewayAuthDir(userId);
    await this.writeConfigFile(authDir, gatewayAuthDir, whatsappId, gatewayToken, userId, options?.modelTier);
    await this.ensureAuthOwnership(authDir);

    // 3. Remove any stale container with this name (idempotent)
    await this.removeContainerByName(containerName);

    // 4. Create + start container
    const configPath = this.resolveGatewayConfigPath(userId);
    const env = [
      `OPENCLAW_CONFIG_PATH=${configPath}`,
      `OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`,
      ...resolveGatewayProviderEnv(),
    ];

    const mounts = this.resolveMounts(userId);
    const hostConfig: Docker.ContainerCreateOptions["HostConfig"] = {
      Mounts: mounts,
      RestartPolicy: { Name: "unless-stopped" },
      // Give Chromium enough shared memory (Docker default 64 MB is too small and
      // causes renderer crashes). 512 MB matches what most headful-Chrome setups need.
      ShmSize: 512 * 1024 * 1024,
      // Cap container RAM to prevent host OOM kills while allowing swap as a buffer.
      Memory: 4 * 1024 * 1024 * 1024,
      MemorySwap: -1,
    };
    if (this.opts.network) {
      hostConfig.NetworkMode = this.opts.network;
    }

    const container = await this.docker.createContainer({
      Image: this.opts.image,
      name: containerName,
      Cmd: ["node", "openclaw.mjs", "gateway", "--allow-unconfigured", "--bind", "lan"],
      Env: env,
      HostConfig: hostConfig,
      Labels: {
        [LABEL_ROLE]: GATEWAY_ROLE,
        [LABEL_USER]: userId,
      },
    });

    await container.start();

    // 5. Health check – wait for container to stay running
    const healthy = await this.waitForHealthy(container.id);
    const finalStatus = healthy ? "running" : "error";
    const updated = await this.store.updateGatewayInstanceStatus(instance.id, finalStatus, container.id);

    return { instance: updated ?? instance, healthy };
  }

  // ---------------------------------------------------------------------------
  // deprovision – idempotent: safe to call even if container is already gone
  // ---------------------------------------------------------------------------
  async deprovision(userId: string): Promise<void> {
    const containerName = this.resolveContainerName(userId);
    await this.removeContainerByName(containerName);

    const instance = await this.store.getGatewayInstanceByUserId(userId);
    if (instance) {
      await this.store.updateGatewayInstanceStatus(instance.id, "stopped", null);
    }
  }

  // ---------------------------------------------------------------------------
  // inspectStatus – queries Docker for the real container state, updates DB
  // ---------------------------------------------------------------------------
  async inspectStatus(userId: string): Promise<GatewayInstanceRecord["status"] | null> {
    const instance = await this.store.getGatewayInstanceByUserId(userId);
    if (!instance) {
      return null;
    }

    const containerName = this.resolveContainerName(userId);
    const containerInfo = await this.findContainerInfo(containerName);
    if (!containerInfo) {
      if (instance.status !== "stopped") {
        await this.store.updateGatewayInstanceStatus(instance.id, "stopped", null);
      }
      return "stopped";
    }

    const inspected = await this.inspectContainer(containerInfo.Id);
    if (!inspected) {
      return instance.status;
    }

    const status = inspected.running
      ? "running"
      : inspected.exitCode !== 0
        ? "error"
        : "stopped";

    if (status !== instance.status || instance.containerId !== containerInfo.Id) {
      await this.store.updateGatewayInstanceStatus(instance.id, status, containerInfo.Id);
    }
    return status;
  }

  // ---------------------------------------------------------------------------
  // restartContainer – restart by deterministic name
  // ---------------------------------------------------------------------------
  async restartContainer(userId: string): Promise<boolean> {
    const containerName = this.resolveContainerName(userId);
    const containerInfo = await this.findContainerInfo(containerName);
    if (!containerInfo) {
      return false;
    }
    try {
      await this.docker.getContainer(containerInfo.Id).restart({ t: 5 });
      return true;
    } catch {
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // reconcile – called once at startup; syncs DB with Docker reality
  // ---------------------------------------------------------------------------
  async reconcile(): Promise<void> {
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: [`${LABEL_ROLE}=${GATEWAY_ROLE}`] },
    });

    const containerByUser = new Map<string, Docker.ContainerInfo>();
    for (const c of containers) {
      const userId = c.Labels?.[LABEL_USER];
      if (userId) {
        containerByUser.set(userId, c);
      }
    }

    const instances = await this.store.listGatewayInstances();
    for (const instance of instances) {
      const container = containerByUser.get(instance.userId);
      if (!container) {
        if (instance.status !== "stopped") {
          await this.store.updateGatewayInstanceStatus(instance.id, "stopped", null);
        }
        continue;
      }

      const running = container.State === "running";
      const status = running ? "running" : "stopped";
      if (instance.status !== status || instance.containerId !== container.Id) {
        await this.store.updateGatewayInstanceStatus(instance.id, status, container.Id);
      }
      containerByUser.delete(instance.userId);
    }

    // Remove orphaned containers (in Docker but not in DB)
    for (const [, container] of containerByUser) {
      try {
        await this.docker.getContainer(container.Id).remove({ force: true });
      } catch {
        // ignore
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `Reconciliation complete: ${instances.length} DB records, ${containers.length} Docker containers.`,
    );
  }

  // ---------------------------------------------------------------------------
  // inspectRuntime – used by server.ts admin proxy to get container IP
  // ---------------------------------------------------------------------------
  async inspectRuntime(containerId: string) {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      const networkData = Object.values(info.NetworkSettings?.Networks ?? {}) as Array<{ IPAddress?: string }>;
      const ip = networkData.find((entry) => entry?.IPAddress)?.IPAddress ?? null;
      return {
        running: Boolean(info.State?.Running),
        status: info.State?.Status ?? "unknown",
        ip,
      };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private resolveContainerName(userId: string) {
    return `${this.opts.containerPrefix}${userId}`;
  }

  private resolveGatewayAuthDir(_userId: string) {
    // With per-user subpath mount, the user's dir is mounted directly at /data/auth
    return "/data/auth";
  }

  private resolveGatewayConfigPath(_userId: string) {
    return path.posix.join("/data/auth", CONFIG_FILENAME);
  }

  private resolveMounts(userId: string): Docker.MountConfig {
    if (this.opts.authVolume) {
      return [
        {
          Type: "volume",
          Source: this.opts.authVolume,
          Target: "/data/auth",
          VolumeOptions: { Subpath: userId },
        } as Docker.MountSettings,
      ];
    }
    return [
      {
        Type: "bind",
        Source: path.join(deployConfig.authRoot, userId),
        Target: "/data/auth",
      },
    ];
  }

  private async writeConfigFile(
    hostAuthDir: string,
    gatewayAuthDir: string,
    whatsappId: string,
    gatewayToken: string,
    userId: string,
    modelTier?: ModelTier,
  ) {
    await fs.mkdir(hostAuthDir, { recursive: true });
    const config = buildConfig(gatewayAuthDir, whatsappId, gatewayToken, modelTier);
    const primary = resolvePrimaryModel(modelTier);
    const fallbacks = resolveModelFallbacks(modelTier);
    // eslint-disable-next-line no-console
    console.log(
      `[provisioner] writing config for userId=${userId} tier=${modelTier ?? "best"} ` +
      `model.primary=${primary} model.fallbacks=[${fallbacks.join(", ")}] ` +
      `contextTokens=${resolveContextTokens(modelTier)}`,
    );
    const configPath = path.join(hostAuthDir, CONFIG_FILENAME);
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

    // Write the per-user plugin file and its manifest alongside openclaw.json.
    // The plugin is discovered via plugins.load.paths in the config above.
    const pluginSource = buildPluginSource(userId, gatewayToken, deployConfig.internalUrl);
    const pluginPath = path.join(hostAuthDir, PLUGIN_FILENAME);
    await fs.writeFile(pluginPath, pluginSource, "utf-8");
    // eslint-disable-next-line no-console
    console.log(`[provisioner] plugin written to ${pluginPath}`);

    // OpenClaw requires an openclaw.plugin.json manifest in the same rootDir as the plugin file.
    const pluginManifest = {
      id: "clawdly-profile",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    };
    const pluginManifestPath = path.join(hostAuthDir, PLUGIN_MANIFEST_FILENAME);
    await fs.writeFile(pluginManifestPath, JSON.stringify(pluginManifest, null, 2), "utf-8");
    // eslint-disable-next-line no-console
    console.log(`[provisioner] plugin manifest written to ${pluginManifestPath}`);
  }

  private async ensureAuthOwnership(authDir: string): Promise<void> {
    if (!this.opts.authVolume) {
      return;
    }
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    const currentGid = typeof process.getgid === "function" ? process.getgid() : null;
    if (currentUid === this.opts.gatewayUid && currentGid === this.opts.gatewayGid) {
      return;
    }
    if (currentUid !== 0) {
      return;
    }
    await chownRecursive(authDir, this.opts.gatewayUid, this.opts.gatewayGid);
  }

  private async findContainerInfo(name: string): Promise<Docker.ContainerInfo | null> {
    const matches = await this.docker.listContainers({
      all: true,
      filters: { name: [name] },
    });
    return matches.find((c) => c.Names?.some((entry) => entry === `/${name}`)) ?? null;
  }

  private async removeContainerByName(name: string): Promise<void> {
    const info = await this.findContainerInfo(name);
    if (!info) {
      return;
    }
    try {
      await this.docker.getContainer(info.Id).remove({ force: true });
    } catch {
      // already gone
    }
  }

  private async inspectContainer(containerId: string) {
    try {
      const info = await this.docker.getContainer(containerId).inspect();
      return {
        running: Boolean(info.State?.Running),
        exitCode: info.State?.ExitCode ?? 0,
        status: info.State?.Status ?? "unknown",
      };
    } catch {
      return null;
    }
  }

  private async waitForHealthy(containerId: string): Promise<boolean> {
    for (let i = 0; i < HEALTH_POLL_MAX_ATTEMPTS; i++) {
      await new Promise((resolve) => setTimeout(resolve, HEALTH_POLL_INTERVAL_MS));
      const result = await this.inspectContainer(containerId);
      if (!result) {
        return false;
      }
      if (!result.running) {
        return false;
      }
      // After 3 seconds of staying running, consider it healthy
      if (i >= 2) {
        return true;
      }
    }
    return false;
  }
}
