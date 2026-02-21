import fs from "node:fs/promises";
import path from "node:path";
import type { DeployStore } from "./store.js";
import { refreshBootstrapFromArtifacts } from "./profile-bootstrap.js";

const safeJson = (json: string | null): unknown[] => {
  if (!json) {
    return [];
  }
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const normalizeLine = (value: string): string => value.replace(/\s+/g, " ").trim();

const unique = (values: string[]): string[] => Array.from(new Set(values));

const extractContactName = (contact: unknown): string | null => {
  if (!contact || typeof contact !== "object") {
    return null;
  }
  const c = contact as Record<string, unknown>;
  const value =
    (typeof c.name === "string" && c.name.trim()) ||
    (typeof c.notify === "string" && c.notify.trim()) ||
    (typeof c.verifiedName === "string" && c.verifiedName.trim()) ||
    null;
  return value ? normalizeLine(value) : null;
};

const extractChatName = (chat: unknown): string | null => {
  if (!chat || typeof chat !== "object") {
    return null;
  }
  const c = chat as Record<string, unknown>;
  const value =
    (typeof c.name === "string" && c.name.trim()) ||
    (typeof c.subject === "string" && c.subject.trim()) ||
    null;
  return value ? normalizeLine(value) : null;
};

const extractMessageText = (msg: unknown): string | null => {
  if (!msg || typeof msg !== "object") {
    return null;
  }
  const m = msg as Record<string, unknown>;
  const inner = m.message as Record<string, unknown> | undefined;
  if (!inner) {
    return null;
  }
  if (typeof inner.conversation === "string") {
    return inner.conversation;
  }
  const ext = inner.extendedTextMessage as Record<string, unknown> | undefined;
  if (typeof ext?.text === "string") {
    return ext.text;
  }
  return null;
};

const isOutbound = (msg: unknown): boolean => {
  if (!msg || typeof msg !== "object") {
    return false;
  }
  const m = msg as Record<string, unknown>;
  const key = m.key as Record<string, unknown> | undefined;
  return key?.fromMe === true;
};

const buildProjectedProfile = (params: {
  whatsappId: string;
  displayName: string | null;
  contactsJson: string | null;
  chatsJson: string | null;
  messagesJson: string | null;
}): string => {
  const contacts = safeJson(params.contactsJson);
  const chats = safeJson(params.chatsJson);
  const messages = safeJson(params.messagesJson);

  const contactNames = unique(
    contacts
      .map(extractContactName)
      .filter((name): name is string => Boolean(name))
      .slice(0, 40),
  );

  const chatNames = unique(
    chats
      .map(extractChatName)
      .filter((name): name is string => Boolean(name))
      .slice(0, 40),
  );

  const messageLines = messages
    .map((msg) => {
      const text = extractMessageText(msg);
      if (!text || text.trim().length === 0) {
        return null;
      }
      const role = isOutbound(msg) ? "me" : "them";
      return `- [${role}] ${normalizeLine(text).slice(0, 240)}`;
    })
    .filter((line): line is string => Boolean(line))
    .slice(0, 30);

  const sections: string[] = [
    "## Identity",
    `- Name: ${params.displayName ?? "Unknown"}`,
    `- WhatsApp: ${params.whatsappId || "Unknown"}`,
  ];

  if (contactNames.length > 0) {
    sections.push("", "## Known Contacts", ...contactNames.map((name) => `- ${name}`));
  }

  if (chatNames.length > 0) {
    sections.push("", "## Active Chats", ...chatNames.map((name) => `- ${name}`));
  }

  if (messageLines.length > 0) {
    sections.push("", "## Recent Conversation Signals", ...messageLines);
  }

  sections.push(
    "",
    "## Notes",
    "- This profile is projection-based from captured WhatsApp data and is refreshed automatically.",
  );

  return `${sections.join("\n")}\n`;
};

export const projectUserProfile = async (
  userId: string,
  whatsappId: string,
  authDir: string,
  store: DeployStore,
  caller = "unknown",
): Promise<void> => {
  // eslint-disable-next-line no-console
  console.log(`[profile-projection] starting userId=${userId} caller=${caller}`);

  const profileData = await store.getProfileData(userId);
  const profileMd = buildProjectedProfile({
    whatsappId,
    displayName: profileData?.displayName ?? null,
    contactsJson: profileData?.contactsJson ?? null,
    chatsJson: profileData?.chatsJson ?? null,
    messagesJson: profileData?.messagesJson ?? null,
  });

  const memoryDir = path.join(authDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  const profilePath = path.join(memoryDir, "user-profile.md");
  await fs.writeFile(profilePath, profileMd, "utf-8");
  await refreshBootstrapFromArtifacts(authDir, { profileMdOverride: profileMd });
  await store.upsertProfileMd(userId, profileMd);

  // eslint-disable-next-line no-console
  console.log(`[profile-projection] completed userId=${userId} profileLen=${profileMd.length}`);
};

export const appendAgentNoteToProfile = async (
  authDir: string,
  note: string,
): Promise<void> => {
  const profilePath = path.join(authDir, "memory", "user-profile.md");
  let existing = "";
  try {
    existing = await fs.readFile(profilePath, "utf-8");
  } catch {
    existing = "## Identity\n- Name: Unknown\n\n## Notes\n";
  }

  const timestamp = new Date().toISOString().slice(0, 10);
  const cleanNote = normalizeLine(note);
  if (!cleanNote) {
    return;
  }

  const next = existing.includes("## Agent Notes")
    ? `${existing}\n- [${timestamp}] ${cleanNote}`
    : `${existing}\n\n## Agent Notes\n- [${timestamp}] ${cleanNote}`;

  await fs.mkdir(path.join(authDir, "memory"), { recursive: true });
  await fs.writeFile(profilePath, next, "utf-8");
  await refreshBootstrapFromArtifacts(authDir, { profileMdOverride: next });
};
