export type SessionState =
  | "waiting"
  | "scanned"
  | "linked"
  | "deploying"
  | "ready"
  | "error"
  | "expired";

export type SessionErrorCode =
  | "SESSION_EXPIRED"
  | "LOGIN_FAILED"
  | "PROVISION_FAILED"
  | "DATABASE_ERROR"
  | "UNKNOWN";

export type ModelTier = "best" | "fast" | "premium";

export type AgentSettings = {
  name: string | null;
  tone: string | null;
  language: string | null;
  modelTier: ModelTier;
  allowlistOnly: boolean;
};

export type LoginSession = {
  id: string;
  state: SessionState;
  createdAt: Date;
  expiresAt: Date;
  authDir: string;
  qr?: string | null;
  whatsappId?: string | null;
  userId?: string | null;
  errorCode?: SessionErrorCode | null;
  errorMessage?: string | null;
};

export type UserRecord = {
  id: string;
  whatsappId: string;
  status: "active" | "pending" | "disconnected";
  createdAt: Date;
};

export type AgentRecord = {
  id: string;
  userId: string;
  gatewayInstanceId: string | null;
  modelTier: ModelTier;
  name: string | null;
  tone: string | null;
  language: string | null;
  allowlistOnly: boolean;
  createdAt: Date;
};

export type GatewayInstanceRecord = {
  id: string;
  userId: string;
  containerId: string | null;
  status: "provisioning" | "running" | "stopped" | "error";
  authDirPath: string;
  createdAt: Date;
};
