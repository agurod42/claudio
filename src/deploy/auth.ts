import { createHmac } from "node:crypto";
import { deployConfig } from "./config.js";

type AuthPayload = {
  sub: string;
  sid: string;
  exp: number;
};

const encode = (value: string) =>
  Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

const decode = (value: string) => {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? padded : padded + "=".repeat(4 - (padded.length % 4));
  return Buffer.from(pad, "base64").toString("utf-8");
};

const sign = (data: string) =>
  createHmac("sha256", deployConfig.authSecret).update(data).digest("base64url");

export const issueToken = (userId: string, sessionId: string, ttlMs = deployConfig.authTtlMs) => {
  const header = encode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload: AuthPayload = {
    sub: userId,
    sid: sessionId,
    exp: Date.now() + ttlMs,
  };
  const body = encode(JSON.stringify(payload));
  const signature = sign(`${header}.${body}`);
  return `${header}.${body}.${signature}`;
};

export const verifyToken = (token: string): AuthPayload | null => {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const [header, body, signature] = parts;
  const expected = sign(`${header}.${body}`);
  if (signature !== expected) {
    return null;
  }
  try {
    const payload = JSON.parse(decode(body)) as AuthPayload;
    if (!payload.sub || !payload.sid || !payload.exp) {
      return null;
    }
    if (Date.now() > payload.exp) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
};
