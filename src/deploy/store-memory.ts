import { randomUUID } from "node:crypto";
import type {
  AgentRecord,
  AgentSettings,
  GatewayInstanceRecord,
  LoginSession,
  UserRecord,
} from "./types.js";
import type { DeployStore, LoginSessionUpdate } from "./store.js";

export class MemoryStore implements DeployStore {
  private sessions = new Map<string, LoginSession>();
  private users = new Map<string, UserRecord>();
  private usersByWhatsapp = new Map<string, string>();
  private agents = new Map<string, AgentRecord>();
  private gateways = new Map<string, GatewayInstanceRecord>();

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
      gatewayInstanceId: null,
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
  ): Promise<GatewayInstanceRecord> {
    const now = new Date();
    const existing = await this.getGatewayInstanceByUserId(userId);
    if (existing) {
      const updated: GatewayInstanceRecord = {
        ...existing,
        status: "provisioning",
        authDirPath: authDir,
        containerId: null,
        createdAt: now,
      };
      this.gateways.set(existing.id, updated);
      return updated;
    }
    const instance: GatewayInstanceRecord = {
      id: `gw_${randomUUID()}`,
      userId,
      containerId: null,
      status: "provisioning",
      authDirPath: authDir,
      createdAt: now,
    };
    this.gateways.set(instance.id, instance);
    return instance;
  }

  async updateGatewayInstanceStatus(
    id: string,
    status: GatewayInstanceRecord["status"],
    containerId?: string | null,
  ): Promise<GatewayInstanceRecord | null> {
    const existing = this.gateways.get(id);
    if (!existing) {
      return null;
    }
    const next: GatewayInstanceRecord = {
      ...existing,
      status,
      containerId: containerId ?? existing.containerId,
    };
    this.gateways.set(id, next);
    return next;
  }
}
