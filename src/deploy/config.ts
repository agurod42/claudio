import os from "node:os";
import path from "node:path";

const parseNumber = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const parseIntNumber = (value: string | undefined, fallback: number) => {
  if (!value) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const resolveAuthRoot = () => {
  const configured = process.env.OPENCLAW_DEPLOY_AUTH_ROOT;
  if (configured && configured.trim().length > 0) {
    return configured.trim();
  }
  return path.join(os.homedir(), ".openclaw", "deploy", "auth");
};

export const deployConfig = {
  env: process.env.NODE_ENV ?? "development",
  port: parseNumber(process.env.OPENCLAW_DEPLOY_PORT, 8080),
  baseUrl: process.env.OPENCLAW_DEPLOY_BASE_URL ?? "",
  sessionTtlMs: parseNumber(process.env.OPENCLAW_DEPLOY_SESSION_TTL_MS, 10 * 60 * 1000),
  authTtlMs: parseNumber(process.env.OPENCLAW_DEPLOY_AUTH_TTL_MS, 24 * 60 * 60 * 1000),
  authRoot: resolveAuthRoot(),
  databaseUrl: process.env.OPENCLAW_DEPLOY_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
  authSecret: process.env.OPENCLAW_DEPLOY_AUTH_SECRET ?? "dev-secret-change-me",
  provisioner: process.env.OPENCLAW_DEPLOY_PROVISIONER ?? "noop",
  dockerImage: process.env.OPENCLAW_DEPLOY_DOCKER_IMAGE ?? "openclaw-gateway:local",
  dockerNetwork: process.env.OPENCLAW_DEPLOY_DOCKER_NETWORK ?? "",
  dockerAuthVolume: process.env.OPENCLAW_DEPLOY_DOCKER_AUTH_VOLUME ?? "",
  dockerContainerPrefix: process.env.OPENCLAW_DEPLOY_DOCKER_PREFIX ?? "clawdly-gw-",
  dockerGatewayUid: parseIntNumber(process.env.OPENCLAW_DEPLOY_DOCKER_GATEWAY_UID, 1000),
  dockerGatewayGid: parseIntNumber(process.env.OPENCLAW_DEPLOY_DOCKER_GATEWAY_GID, 1000),
  adminToken: process.env.OPENCLAW_DEPLOY_ADMIN_TOKEN ?? "",
  reaperIntervalMs: parseNumber(process.env.OPENCLAW_DEPLOY_REAPER_INTERVAL_MS, 10 * 60 * 1000),
  reaperMaxAgeMs: parseNumber(process.env.OPENCLAW_DEPLOY_REAPER_TTL_MS, 6 * 60 * 60 * 1000),
  // URL that gateway containers use to call back to this deploy server.
  // Must be reachable from inside the Docker network (e.g. http://deploy:8080).
  internalUrl: process.env.OPENCLAW_DEPLOY_INTERNAL_URL ?? "http://deploy:8080",
};
