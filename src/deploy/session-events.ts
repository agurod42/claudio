import { EventEmitter } from "node:events";
import type { SessionErrorCode, SessionState } from "./types.js";

export type SessionEvent =
  | { type: "qr"; qr: string; expiresAt: Date }
  | { type: "status"; state: SessionState; message?: string }
  | { type: "error"; code: SessionErrorCode; message: string };

export type SessionSnapshot = {
  state: SessionState;
  message?: string;
  qr?: string | null;
  qrExpiresAt?: Date | null;
  error?: { code: SessionErrorCode; message: string } | null;
};

export class SessionEvents {
  private emitter = new EventEmitter();
  private snapshots = new Map<string, SessionSnapshot>();

  emit(sessionId: string, event: SessionEvent) {
    const next = this.applySnapshot(sessionId, event);
    this.emitter.emit(sessionId, event, next);
  }

  on(
    sessionId: string,
    listener: (event: SessionEvent, snapshot: SessionSnapshot) => void,
  ): () => void {
    const handler = (event: SessionEvent, snapshot: SessionSnapshot) => {
      listener(event, snapshot);
    };
    this.emitter.on(sessionId, handler);
    return () => this.emitter.off(sessionId, handler);
  }

  snapshot(sessionId: string): SessionSnapshot | null {
    return this.snapshots.get(sessionId) ?? null;
  }

  private applySnapshot(sessionId: string, event: SessionEvent): SessionSnapshot {
    const existing = this.snapshots.get(sessionId) ?? { state: "waiting" };
    let next: SessionSnapshot = { ...existing };
    if (event.type === "qr") {
      next = { ...next, qr: event.qr, qrExpiresAt: event.expiresAt };
    }
    if (event.type === "status") {
      next = { ...next, state: event.state, message: event.message };
      if (event.state === "ready") {
        next = { ...next, error: null };
      }
    }
    if (event.type === "error") {
      next = { ...next, state: "error", error: { code: event.code, message: event.message } };
    }
    this.snapshots.set(sessionId, next);
    return next;
  }
}
