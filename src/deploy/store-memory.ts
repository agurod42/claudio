import { randomUUID } from "node:crypto";
import type {
  AgentRecord,
  AgentSettings,
  GatewayInstanceRecord,
  GatewayRuntimeFingerprint,
  LoginSession,
  ProfileDataRecord,
  ProfileMessageEventInput,
  ProfileMessageEventRecord,
  RawProfileData,
  UserRecord,
} from "./types.js";
import type { DeployStore, LoginSessionUpdate } from "./store.js";

export class MemoryStore implements DeployStore {
  private sessions = new Map<string, LoginSession>();
  private users = new Map<string, UserRecord>();
  private usersByWhatsapp = new Map<string, string>();
  private agents = new Map<string, AgentRecord>();
  private gateways = new Map<string, GatewayInstanceRecord>();
  private profileData = new Map<string, ProfileDataRecord>();
  private profileMessageEvents = new Map<string, ProfileMessageEventRecord[]>();

  async createLoginSession(session: LoginSession): Promise<LoginSession> {
    this.sessions.set(session.id, session);
    return session;
  }

  async getLoginSession(id: string): Promise<LoginSession | null> {
    return this.sessions.get(id) ?? null;
  }

  async listLoginSessions(): Promise<LoginSession[]> {
    return Array.from(this.sessions.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  async updateLoginSession(id: string, update: LoginSessionUpdate): Promise<LoginSession | null> {
    const existing = this.sessions.get(id);
    if (!existing) {
      return null;
    }
    const next: LoginSession = {
      ...existing,
      ...update,
    };
    this.sessions.set(id, next);
    return next;
  }

  async getOrCreateUserByWhatsappId(whatsappId: string): Promise<UserRecord> {
    const existingId = this.usersByWhatsapp.get(whatsappId);
    if (existingId) {
      const existing = this.users.get(existingId);
      if (existing) {
        return existing;
      }
    }
    const now = new Date();
    const user: UserRecord = {
      id: `user_${randomUUID()}`,
      whatsappId,
      status: "active",
      createdAt: now,
    };
    this.users.set(user.id, user);
    this.usersByWhatsapp.set(whatsappId, user.id);
    return user;
  }

  async listUsers(): Promise<UserRecord[]> {
    return Array.from(this.users.values()).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async listAgents(): Promise<AgentRecord[]> {
    return Array.from(this.agents.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime(),
    );
  }

  async getAgentByUserId(userId: string): Promise<AgentRecord | null> {
    for (const agent of this.agents.values()) {
      if (agent.userId === userId) {
        return agent;
      }
    }
    return null;
  }

  async createAgentForUser(userId: string, settings: AgentSettings): Promise<AgentRecord> {
    const now = new Date();
    const agent: AgentRecord = {
      id: `ag_${randomUUID()}`,
      userId,
      modelTier: settings.modelTier,
      name: settings.name ?? null,
      tone: settings.tone ?? null,
      language: settings.language ?? null,
      allowlistOnly: settings.allowlistOnly,
      createdAt: now,
    };
    this.agents.set(agent.id, agent);
    return agent;
  }

  async updateAgentSettings(
    userId: string,
    update: Partial<AgentSettings>,
  ): Promise<AgentRecord | null> {
    const existing = await this.getAgentByUserId(userId);
    if (!existing) {
      return null;
    }
    const next: AgentRecord = {
      ...existing,
      modelTier: update.modelTier ?? existing.modelTier,
      name: update.name ?? existing.name,
      tone: update.tone ?? existing.tone,
      language: update.language ?? existing.language,
      allowlistOnly: update.allowlistOnly ?? existing.allowlistOnly,
    };
    this.agents.set(existing.id, next);
    return next;
  }

  async getGatewayInstanceByUserId(userId: string): Promise<GatewayInstanceRecord | null> {
    for (const instance of this.gateways.values()) {
      if (instance.userId === userId) {
        return instance;
      }
    }
    return null;
  }

  async listGatewayInstances(): Promise<GatewayInstanceRecord[]> {
    return Array.from(this.gateways.values());
  }

  async createGatewayInstanceForUser(
    userId: string,
    authDir: string,
    extra?: {
      gatewayToken?: string;
      containerName?: string;
      runtime?: GatewayRuntimeFingerprint;
      reconciledAt?: Date | null;
    },
  ): Promise<GatewayInstanceRecord> {
    const now = new Date();
    const existing = await this.getGatewayInstanceByUserId(userId);
    if (existing) {
      const updated: GatewayInstanceRecord = {
        ...existing,
        status: "provisioning",
        authDirPath: authDir,
        containerId: null,
        gatewayToken: extra?.gatewayToken ?? existing.gatewayToken,
        containerName: extra?.containerName ?? existing.containerName,
        configVersion: extra?.runtime?.configVersion ?? existing.configVersion,
        pluginVersion: extra?.runtime?.pluginVersion ?? existing.pluginVersion,
        runtimePolicyVersion: extra?.runtime?.runtimePolicyVersion ?? existing.runtimePolicyVersion,
        imageRef: extra?.runtime?.imageRef ?? existing.imageRef,
        reconciledAt: extra?.reconciledAt ?? existing.reconciledAt,
        createdAt: now,
      };
      this.gateways.set(existing.id, updated);
      return updated;
    }
    const instance: GatewayInstanceRecord = {
      id: `gw_${randomUUID()}`,
      userId,
      containerId: null,
      containerName: extra?.containerName ?? "",
      status: "provisioning",
      authDirPath: authDir,
      gatewayToken: extra?.gatewayToken ?? "",
      configVersion: extra?.runtime?.configVersion ?? "",
      pluginVersion: extra?.runtime?.pluginVersion ?? "",
      runtimePolicyVersion: extra?.runtime?.runtimePolicyVersion ?? "",
      imageRef: extra?.runtime?.imageRef ?? "",
      reconciledAt: extra?.reconciledAt ?? null,
      createdAt: now,
    };
    this.gateways.set(instance.id, instance);
    return instance;
  }

  async deleteExpiredLoginSessions(before: Date): Promise<number> {
    let count = 0;
    for (const [id, session] of this.sessions) {
      if (session.expiresAt < before) {
        this.sessions.delete(id);
        count++;
      }
    }
    return count;
  }

  async upsertRawProfileData(userId: string, data: RawProfileData): Promise<void> {
    const existing = this.profileData.get(userId);
    this.profileData.set(userId, {
      userId,
      displayName: data.displayName ?? existing?.displayName ?? null,
      contactsJson: data.contacts && data.contacts.length > 0
        ? JSON.stringify(data.contacts)
        : (existing?.contactsJson ?? null),
      chatsJson: data.chats && data.chats.length > 0
        ? JSON.stringify(data.chats)
        : (existing?.chatsJson ?? null),
      messagesJson: data.messages && data.messages.length > 0
        ? JSON.stringify(data.messages)
        : (existing?.messagesJson ?? null),
      profileMd: existing?.profileMd ?? null,
      profileUpdatedAt: existing?.profileUpdatedAt ?? null,
      rawUpdatedAt: new Date(),
    });
  }

  async getProfileData(userId: string): Promise<ProfileDataRecord | null> {
    return this.profileData.get(userId) ?? null;
  }

  async upsertProfileMd(userId: string, profileMd: string): Promise<void> {
    const existing = this.profileData.get(userId);
    this.profileData.set(userId, {
      userId,
      displayName: existing?.displayName ?? null,
      contactsJson: existing?.contactsJson ?? null,
      chatsJson: existing?.chatsJson ?? null,
      messagesJson: existing?.messagesJson ?? null,
      profileMd,
      profileUpdatedAt: new Date(),
      rawUpdatedAt: existing?.rawUpdatedAt ?? new Date(),
    });
  }

  async appendProfileMessageEvent(event: ProfileMessageEventInput): Promise<ProfileMessageEventRecord> {
    const now = new Date();
    const row: ProfileMessageEventRecord = {
      id: `pme_${randomUUID()}`,
      userId: event.userId,
      channel: event.channel.trim() || "whatsapp",
      peerId: event.peerId.trim(),
      direction: event.direction,
      content: event.content,
      metadataJson: event.metadataJson ?? null,
      occurredAt: event.occurredAt ?? now,
      createdAt: now,
    };
    const existing = this.profileMessageEvents.get(event.userId) ?? [];
    existing.push(row);
    // Keep in-memory store bounded to avoid unbounded growth in dev/no-db mode.
    const MAX_PER_USER = 10_000;
    if (existing.length > MAX_PER_USER) {
      existing.splice(0, existing.length - MAX_PER_USER);
    }
    this.profileMessageEvents.set(event.userId, existing);
    return row;
  }

  async listProfileMessageEvents(params: {
    userId: string;
    channel?: string;
    peerId?: string;
    direction?: "inbound" | "outbound";
    from?: Date;
    to?: Date;
    limit?: number;
  }): Promise<ProfileMessageEventRecord[]> {
    const list = [...(this.profileMessageEvents.get(params.userId) ?? [])];
    const filtered = list.filter((row) => {
      if (params.channel && row.channel !== params.channel) {
        return false;
      }
      if (params.peerId && row.peerId !== params.peerId) {
        return false;
      }
      if (params.direction && row.direction !== params.direction) {
        return false;
      }
      if (params.from && row.occurredAt < params.from) {
        return false;
      }
      if (params.to && row.occurredAt > params.to) {
        return false;
      }
      return true;
    });
    filtered.sort((a, b) => {
      const byOccurredAt = a.occurredAt.getTime() - b.occurredAt.getTime();
      if (byOccurredAt !== 0) {
        return byOccurredAt;
      }
      const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime();
      if (byCreatedAt !== 0) {
        return byCreatedAt;
      }
      return a.id.localeCompare(b.id);
    });
    if (params.limit && params.limit > 0 && filtered.length > params.limit) {
      return filtered.slice(filtered.length - params.limit);
    }
    return filtered;
  }

  async updateGatewayInstanceStatus(
    id: string,
    status: GatewayInstanceRecord["status"],
    containerId?: string | null,
    extra?: {
      runtime?: GatewayRuntimeFingerprint;
      reconciledAt?: Date | null;
    },
  ): Promise<GatewayInstanceRecord | null> {
    const existing = this.gateways.get(id);
    if (!existing) {
      return null;
    }
    const next: GatewayInstanceRecord = {
      ...existing,
      status,
      containerId: containerId === undefined ? existing.containerId : containerId,
      configVersion: extra?.runtime?.configVersion ?? existing.configVersion,
      pluginVersion: extra?.runtime?.pluginVersion ?? existing.pluginVersion,
      runtimePolicyVersion: extra?.runtime?.runtimePolicyVersion ?? existing.runtimePolicyVersion,
      imageRef: extra?.runtime?.imageRef ?? existing.imageRef,
      reconciledAt:
        extra?.reconciledAt === undefined
          ? existing.reconciledAt
          : extra.reconciledAt,
    };
    this.gateways.set(id, next);
    return next;
  }
}
