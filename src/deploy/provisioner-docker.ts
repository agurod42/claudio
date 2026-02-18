import Docker from "dockerode";
import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { deployConfig } from "./config.js";
import type { DeployStore } from "./store.js";
import type { GatewayInstanceRecord, ModelTier } from "./types.js";
import type { ProvisionOptions, ProvisionResult, Provisioner } from "./provisioner.js";

const CONFIG_FILENAME = "openclaw.json";
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

    // 2. Write openclaw.json config
    const gatewayAuthDir = this.resolveGatewayAuthDir(userId);
    await this.writeConfigFile(authDir, gatewayAuthDir, whatsappId, gatewayToken, options?.modelTier);
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
    modelTier?: ModelTier,
  ) {
    await fs.mkdir(hostAuthDir, { recursive: true });
    const config = buildConfig(gatewayAuthDir, whatsappId, gatewayToken, modelTier);
    const configPath = path.join(hostAuthDir, CONFIG_FILENAME);
    await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
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
