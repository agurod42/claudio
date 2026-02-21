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
  containerName: string;
  status: "provisioning" | "running" | "stopped" | "error";
  authDirPath: string;
  gatewayToken: string;
  configVersion: string;
  pluginVersion: string;
  runtimePolicyVersion: string;
  imageRef: string;
  reconciledAt: Date | null;
  createdAt: Date;
};

export type GatewayRuntimeFingerprint = {
  configVersion: string;
  pluginVersion: string;
  runtimePolicyVersion: string;
  imageRef: string;
};

export type RawProfileData = {
  displayName?: string | null;
  contacts?: unknown[];
  chats?: unknown[];
  messages?: unknown[];
};

export type ProfileDataRecord = {
  userId: string;
  displayName: string | null;
  contactsJson: string | null;
  chatsJson: string | null;
  messagesJson: string | null;
  profileMd: string | null;
  profileUpdatedAt: Date | null;
  rawUpdatedAt: Date;
};

export type ProfileMessageDirection = "inbound" | "outbound";

export type ProfileMessageEventInput = {
  userId: string;
  channel: string;
  peerId: string;
  direction: ProfileMessageDirection;
  content: string;
  occurredAt?: Date;
  metadataJson?: string | null;
};

export type ProfileMessageEventRecord = {
  id: string;
  userId: string;
  channel: string;
  peerId: string;
  direction: ProfileMessageDirection;
  content: string;
  metadataJson: string | null;
  occurredAt: Date;
  createdAt: Date;
};
