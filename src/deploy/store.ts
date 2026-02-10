import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { deployConfig } from "./config.js";
import type {
  AgentRecord,
  AgentSettings,
  GatewayInstanceRecord,
  LoginSession,
  SessionErrorCode,
  SessionState,
  UserRecord,
} from "./types.js";
import { MemoryStore } from "./store-memory.js";
import { PostgresStore } from "./store-postgres.js";

export type LoginSessionUpdate = {
  state?: SessionState;
  errorCode?: SessionErrorCode | null;
  errorMessage?: string | null;
  whatsappId?: string | null;
  userId?: string | null;
};

export interface DeployStore {
  createLoginSession(session: LoginSession): Promise<LoginSession>;
  getLoginSession(id: string): Promise<LoginSession | null>;
  updateLoginSession(id: string, update: LoginSessionUpdate): Promise<LoginSession | null>;
  getOrCreateUserByWhatsappId(whatsappId: string): Promise<UserRecord>;
  getAgentByUserId(userId: string): Promise<AgentRecord | null>;
  createAgentForUser(userId: string, settings: AgentSettings): Promise<AgentRecord>;
  updateAgentSettings(userId: string, update: Partial<AgentSettings>): Promise<AgentRecord | null>;
  getGatewayInstanceByUserId(userId: string): Promise<GatewayInstanceRecord | null>;
  listGatewayInstances(): Promise<GatewayInstanceRecord[]>;
  createGatewayInstanceForUser(userId: string, authDir: string): Promise<GatewayInstanceRecord>;
  updateGatewayInstanceStatus(
    id: string,
    status: GatewayInstanceRecord["status"],
    containerId?: string | null,
  ): Promise<GatewayInstanceRecord | null>;
}

export const createStore = (pool: Pool | null): DeployStore => {
  if (!pool) {
    return new MemoryStore();
  }
  return new PostgresStore(pool);
};

export const createLoginSessionRecord = (params: {
  authDir: string;
  expiresAt: Date;
}): LoginSession => {
  const now = new Date();
  return {
    id: `ls_${randomUUID()}`,
    state: "waiting",
    createdAt: now,
    expiresAt: params.expiresAt,
    authDir: params.authDir,
    qr: null,
    whatsappId: null,
    userId: null,
    errorCode: null,
    errorMessage: null,
  };
};

export const defaultAgentSettings = (): AgentSettings => ({
  name: null,
  tone: "clear and concise",
  language: "auto",
  modelTier: "best",
  allowlistOnly: true,
});

export const resolveBaseUrl = (port: number) => {
  if (deployConfig.baseUrl && deployConfig.baseUrl.trim().length > 0) {
    return deployConfig.baseUrl.trim().replace(/\/+$/, "");
  }
  return `http://localhost:${port}`;
};
