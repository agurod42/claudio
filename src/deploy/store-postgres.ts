import { randomUUID } from "node:crypto";
import type { Pool, QueryResultRow } from "pg";
import type {
  AgentRecord,
  AgentSettings,
  GatewayInstanceRecord,
  LoginSession,
  SessionErrorCode,
  UserRecord,
} from "./types.js";
import type { DeployStore, LoginSessionUpdate } from "./store.js";

const parseDate = (value: unknown) => {
  if (value instanceof Date) {
    return value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return new Date(0);
};

const parseSessionErrorCode = (value: unknown): SessionErrorCode | null => {
  if (
    value === "SESSION_EXPIRED" ||
    value === "LOGIN_FAILED" ||
    value === "PROVISION_FAILED" ||
    value === "DATABASE_ERROR" ||
    value === "UNKNOWN"
  ) {
    return value;
  }
  return null;
};

const mapLoginSession = (row: QueryResultRow): LoginSession => ({
  id: String(row.id),
  state: row.state,
  createdAt: parseDate(row.created_at),
  expiresAt: parseDate(row.expires_at),
  authDir: String(row.auth_dir),
  qr: null,
  whatsappId: row.whatsapp_id ? String(row.whatsapp_id) : null,
  userId: row.user_id ? String(row.user_id) : null,
  errorCode: parseSessionErrorCode(row.error_code),
  errorMessage: row.error_message ? String(row.error_message) : null,
});

const mapUser = (row: QueryResultRow): UserRecord => ({
  id: String(row.id),
  whatsappId: String(row.whatsapp_id),
  status: row.status,
  createdAt: parseDate(row.created_at),
});

const mapAgent = (row: QueryResultRow): AgentRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  gatewayInstanceId: row.gateway_instance_id ? String(row.gateway_instance_id) : null,
  modelTier: row.model_tier,
  name: row.name ? String(row.name) : null,
  tone: row.tone ? String(row.tone) : null,
  language: row.language ? String(row.language) : null,
  allowlistOnly: Boolean(row.allowlist_only),
  createdAt: parseDate(row.created_at),
});

const mapGateway = (row: QueryResultRow): GatewayInstanceRecord => ({
  id: String(row.id),
  userId: String(row.user_id),
  containerId: row.container_id ? String(row.container_id) : null,
  containerName: row.container_name ? String(row.container_name) : "",
  status: row.status,
  authDirPath: String(row.auth_dir_path),
  gatewayToken: row.gateway_token ? String(row.gateway_token) : "",
  createdAt: parseDate(row.created_at),
});

export class PostgresStore implements DeployStore {
  constructor(private pool: Pool) {}

  async createLoginSession(session: LoginSession): Promise<LoginSession> {
    await this.pool.query(
      `insert into login_sessions
      (id, user_id, state, error_code, error_message, auth_dir, whatsapp_id, expires_at, created_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        session.id,
        session.userId,
        session.state,
        session.errorCode,
        session.errorMessage,
        session.authDir,
        session.whatsappId,
        session.expiresAt,
        session.createdAt,
      ],
    );
    return session;
  }

  async getLoginSession(id: string): Promise<LoginSession | null> {
    const result = await this.pool.query("select * from login_sessions where id = $1", [id]);
    if (result.rowCount === 0) {
      return null;
    }
    return mapLoginSession(result.rows[0]);
  }

  async listLoginSessions(): Promise<LoginSession[]> {
    const result = await this.pool.query("select * from login_sessions order by created_at desc");
    return result.rows.map(mapLoginSession);
  }

  async updateLoginSession(id: string, update: LoginSessionUpdate): Promise<LoginSession | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (update.state) {
      fields.push(`state = $${idx++}`);
      values.push(update.state);
    }
    if (update.errorCode !== undefined) {
      fields.push(`error_code = $${idx++}`);
      values.push(update.errorCode);
    }
    if (update.errorMessage !== undefined) {
      fields.push(`error_message = $${idx++}`);
      values.push(update.errorMessage);
    }
    if (update.whatsappId !== undefined) {
      fields.push(`whatsapp_id = $${idx++}`);
      values.push(update.whatsappId);
    }
    if (update.userId !== undefined) {
      fields.push(`user_id = $${idx++}`);
      values.push(update.userId);
    }
    if (update.authDir !== undefined) {
      fields.push(`auth_dir = $${idx++}`);
      values.push(update.authDir);
    }
    if (fields.length === 0) {
      return this.getLoginSession(id);
    }
    values.push(id);
    const query = `update login_sessions set ${fields.join(", ")} where id = $${idx} returning *`;
    const result = await this.pool.query(query, values);
    if (result.rowCount === 0) {
      return null;
    }
    return mapLoginSession(result.rows[0]);
  }

  async getOrCreateUserByWhatsappId(whatsappId: string): Promise<UserRecord> {
    const existing = await this.pool.query("select * from users where whatsapp_id = $1", [
      whatsappId,
    ]);
    if (existing.rowCount && existing.rows[0]) {
      return mapUser(existing.rows[0]);
    }
    const userId = `user_${randomUUID()}`;
    const created = await this.pool.query(
      "insert into users (id, whatsapp_id, status) values ($1,$2,$3) returning *",
      [userId, whatsappId, "active"],
    );
    return mapUser(created.rows[0]);
  }

  async listUsers(): Promise<UserRecord[]> {
    const result = await this.pool.query("select * from users order by created_at desc");
    return result.rows.map(mapUser);
  }

  async listAgents(): Promise<AgentRecord[]> {
    const result = await this.pool.query("select * from agents order by created_at desc");
    return result.rows.map(mapAgent);
  }

  async getAgentByUserId(userId: string): Promise<AgentRecord | null> {
    const result = await this.pool.query("select * from agents where user_id = $1 limit 1", [
      userId,
    ]);
    if (!result.rowCount) {
      return null;
    }
    return mapAgent(result.rows[0]);
  }

  async createAgentForUser(userId: string, settings: AgentSettings): Promise<AgentRecord> {
    const id = `ag_${randomUUID()}`;
    const result = await this.pool.query(
      `insert into agents
      (id, user_id, gateway_instance_id, model_tier, name, tone, language, allowlist_only)
      values ($1,$2,$3,$4,$5,$6,$7,$8)
      returning *`,
      [
        id,
        userId,
        null,
        settings.modelTier,
        settings.name,
        settings.tone,
        settings.language,
        settings.allowlistOnly,
      ],
    );
    return mapAgent(result.rows[0]);
  }

  async updateAgentSettings(
    userId: string,
    update: Partial<AgentSettings>,
  ): Promise<AgentRecord | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let idx = 1;
    if (update.modelTier !== undefined) {
      fields.push(`model_tier = $${idx++}`);
      values.push(update.modelTier);
    }
    if (update.name !== undefined) {
      fields.push(`name = $${idx++}`);
      values.push(update.name);
    }
    if (update.tone !== undefined) {
      fields.push(`tone = $${idx++}`);
      values.push(update.tone);
    }
    if (update.language !== undefined) {
      fields.push(`language = $${idx++}`);
      values.push(update.language);
    }
    if (update.allowlistOnly !== undefined) {
      fields.push(`allowlist_only = $${idx++}`);
      values.push(update.allowlistOnly);
    }
    if (fields.length === 0) {
      return this.getAgentByUserId(userId);
    }
    values.push(userId);
    const query = `update agents set ${fields.join(", ")} where user_id = $${idx} returning *`;
    const result = await this.pool.query(query, values);
    if (!result.rowCount) {
      return null;
    }
    return mapAgent(result.rows[0]);
  }

  async getGatewayInstanceByUserId(userId: string): Promise<GatewayInstanceRecord | null> {
    const result = await this.pool.query(
      "select * from gateway_instances where user_id = $1 order by created_at desc limit 1",
      [userId],
    );
    if (!result.rowCount) {
      return null;
    }
    return mapGateway(result.rows[0]);
  }

  async listGatewayInstances(): Promise<GatewayInstanceRecord[]> {
    const result = await this.pool.query("select * from gateway_instances");
    return result.rows.map(mapGateway);
  }

  async createGatewayInstanceForUser(
    userId: string,
    authDir: string,
    extra?: { gatewayToken?: string; containerName?: string },
  ): Promise<GatewayInstanceRecord> {
    const id = `gw_${randomUUID()}`;
    const result = await this.pool.query(
      `insert into gateway_instances
      (id, user_id, container_id, status, auth_dir_path, gateway_token, container_name)
      values ($1,$2,$3,$4,$5,$6,$7)
      on conflict (user_id)
      do update set
        status = excluded.status,
        auth_dir_path = excluded.auth_dir_path,
        gateway_token = coalesce(excluded.gateway_token, gateway_instances.gateway_token),
        container_name = coalesce(excluded.container_name, gateway_instances.container_name),
        container_id = null,
        created_at = now()
      returning *`,
      [id, userId, null, "provisioning", authDir, extra?.gatewayToken ?? null, extra?.containerName ?? null],
    );
    return mapGateway(result.rows[0]);
  }

  async updateGatewayInstanceStatus(
    id: string,
    status: GatewayInstanceRecord["status"],
    containerId?: string | null,
  ): Promise<GatewayInstanceRecord | null> {
    const fields = ["status = $1"];
    const values: unknown[] = [status];
    let idx = 2;
    if (containerId !== undefined) {
      fields.push(`container_id = $${idx++}`);
      values.push(containerId);
    }
    values.push(id);
    const result = await this.pool.query(
      `update gateway_instances set ${fields.join(", ")} where id = $${idx} returning *`,
      values,
    );
    if (!result.rowCount) {
      return null;
    }
    return mapGateway(result.rows[0]);
  }

  async deleteExpiredLoginSessions(before: Date): Promise<number> {
    const result = await this.pool.query(
      "delete from login_sessions where expires_at < $1",
      [before],
    );
    return result.rowCount ?? 0;
  }
}
