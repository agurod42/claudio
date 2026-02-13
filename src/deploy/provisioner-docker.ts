import Docker from "dockerode";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { deployConfig } from "./config.js";
import type { DeployStore } from "./store.js";
import type { GatewayInstanceRecord, ModelTier } from "./types.js";
import type { ProvisionOptions, Provisioner } from "./provisioner.js";

const AUTH_MOUNT_PATH = "/data/auth";
const SHARED_AUTH_MOUNT_PATH = "/data/auth-shared";
const CONFIG_FILENAME = "openclaw.json";

type DockerProvisionerOptions = {
  image: string;
  network?: string;
  authVolume?: string;
  containerPrefix: string;
  gatewayUid: number;
  gatewayGid: number;
};

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
] as const;

const DEFAULT_TOOLS_PROFILE = "minimal";

const MODEL_PRIMARY_BY_TIER: Record<ModelTier, string> = {
  best: "groq/llama-3.3-70b-versatile",
  fast: "groq/llama-3.1-8b-instant",
  premium: "groq/llama-3.3-70b-versatile",
};

const MODEL_FALLBACKS_BY_TIER: Record<ModelTier, string[]> = {
  best: ["groq/llama-3.1-8b-instant"],
  fast: ["groq/llama-3.3-70b-versatile"],
  premium: ["groq/llama-3.1-8b-instant"],
};

const MODEL_CONTEXT_TOKENS_BY_TIER: Record<ModelTier, number> = {
  // Keep context conservative to stay under Groq per-request TPM limits.
  best: 16_000,
  fast: 16_000,
  premium: 16_000,
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
    entries: {
      whatsapp: {
        enabled: true,
      },
    },
  },
  agents: {
    defaults: {
      contextTokens: resolveContextTokens(modelTier),
      model: {
        primary: resolvePrimaryModel(modelTier),
        fallbacks: resolveModelFallbacks(modelTier),
      },
    },
  },
  tools: {
    profile: DEFAULT_TOOLS_PROFILE,
  },
});

const ensureConfigFile = async (
  hostAuthDir: string,
  gatewayAuthDir: string,
  whatsappId: string,
  gatewayToken: string,
  modelTier?: ModelTier,
) => {
  await fs.mkdir(hostAuthDir, { recursive: true });
  const config = buildConfig(gatewayAuthDir, whatsappId, gatewayToken, modelTier);
  const configPath = path.join(hostAuthDir, CONFIG_FILENAME);
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  return configPath;
};

const resolveGatewayPaths = (authDir: string, authVolume?: string) => {
  if (authVolume && authVolume.trim().length > 0) {
    const sessionDir = path.basename(authDir);
    const gatewayAuthDir = path.posix.join(SHARED_AUTH_MOUNT_PATH, sessionDir);
    return {
      binds: [`${authVolume}:${SHARED_AUTH_MOUNT_PATH}`],
      gatewayAuthDir,
      configPath: path.posix.join(gatewayAuthDir, CONFIG_FILENAME),
    };
  }
  return {
    binds: [`${authDir}:${AUTH_MOUNT_PATH}`],
    gatewayAuthDir: AUTH_MOUNT_PATH,
    configPath: path.posix.join(AUTH_MOUNT_PATH, CONFIG_FILENAME),
  };
};

const resolveGatewayProviderEnv = () =>
  GATEWAY_ENV_PASSTHROUGH.flatMap((name) => {
    const value = process.env[name];
    if (!value || value.trim().length === 0) {
      return [];
    }
    return [`${name}=${value}`];
  });

const resolveContainerName = (prefix: string, userId: string) => `${prefix}${userId}`;

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

  async provision(
    userId: string,
    authDir: string,
    whatsappId: string,
    options?: ProvisionOptions,
  ): Promise<GatewayInstanceRecord> {
    const instance = await this.store.createGatewayInstanceForUser(userId, authDir);
    const gatewayToken = randomBytes(24).toString("hex");
    const gatewayPaths = resolveGatewayPaths(authDir, this.opts.authVolume);
    await ensureConfigFile(
      authDir,
      gatewayPaths.gatewayAuthDir,
      whatsappId,
      gatewayToken,
      options?.modelTier,
    );
    await this.ensureGatewayAuthOwnership(authDir);
    const containerName = resolveContainerName(this.opts.containerPrefix, userId);

    const existing = await this.findContainerByName(containerName);
    if (existing) {
      await existing.remove({ force: true });
    }

    const env = [
      `OPENCLAW_CONFIG_PATH=${gatewayPaths.configPath}`,
      `OPENCLAW_GATEWAY_TOKEN=${gatewayToken}`,
      ...resolveGatewayProviderEnv(),
    ];

    const hostConfig: Docker.ContainerCreateOptions["HostConfig"] = {
      Binds: gatewayPaths.binds,
      RestartPolicy: { Name: "unless-stopped" },
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
        "clawdly.role": "gateway",
        "clawdly.user": userId,
      },
    });

    await container.start();
    const updated = await this.refreshInstance({
      ...instance,
      containerId: container.id,
      status: "running",
    });
    return updated ?? instance;
  }

  async deprovision(instance: GatewayInstanceRecord): Promise<GatewayInstanceRecord | null> {
    if (instance.containerId) {
      try {
        await this.docker.getContainer(instance.containerId).remove({ force: true });
      } catch {
        // ignore
      }
    }
    return await this.store.updateGatewayInstanceStatus(instance.id, "stopped", null);
  }

  private async ensureGatewayAuthOwnership(authDir: string): Promise<void> {
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

  private async findContainerByName(name: string) {
    const matches = await this.docker.listContainers({
      all: true,
      filters: { name: [name] },
    });
    const match = matches.find((container) =>
      container.Names?.some((entry) => entry === `/${name}`),
    );
    if (!match?.Id) {
      return null;
    }
    return this.docker.getContainer(match.Id);
  }

  async refreshInstance(instance: GatewayInstanceRecord): Promise<GatewayInstanceRecord | null> {
    if (!instance.containerId) {
      return instance;
    }
    try {
      const container = this.docker.getContainer(instance.containerId);
      const info = await container.inspect();
      const running = Boolean(info.State?.Running);
      const exitCode = info.State?.ExitCode ?? 0;
      const status = running ? "running" : exitCode === 0 ? "stopped" : "error";
      return await this.store.updateGatewayInstanceStatus(instance.id, status, instance.containerId);
    } catch {
      return instance;
    }
  }

  async reapStale(maxAgeMs: number): Promise<void> {
    const instances = await this.store.listGatewayInstances();
    const known = new Set(instances.map((item) => item.containerId).filter(Boolean));
    const now = Date.now();
    const containers = await this.docker.listContainers({
      all: true,
      filters: { label: ["clawdly.role=gateway"] },
    });

    for (const containerInfo of containers) {
      if (!containerInfo.Id) {
        continue;
      }
      if (!known.has(containerInfo.Id)) {
        try {
          await this.docker.getContainer(containerInfo.Id).remove({ force: true });
        } catch {
          // ignore
        }
      }
    }

    for (const instance of instances) {
      if (!instance.containerId) {
        continue;
      }
      if (instance.status === "running") {
        continue;
      }
      const ageMs = now - instance.createdAt.getTime();
      if (ageMs < maxAgeMs) {
        continue;
      }
      try {
        await this.docker.getContainer(instance.containerId).remove({ force: true });
        await this.store.updateGatewayInstanceStatus(instance.id, "stopped", instance.containerId);
      } catch {
        // ignore
      }
    }
  }

  startReaper(intervalMs: number, maxAgeMs: number): () => void {
    const timer = setInterval(() => {
      this.reapStale(maxAgeMs).catch(() => undefined);
    }, intervalMs);
    return () => clearInterval(timer);
  }
}
