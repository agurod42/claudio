import type { ProfileDataRecord } from "./types.js";

export type WhatsAppDirectoryPeer = {
  id: string;
  name?: string;
  handle?: string;
  accountId?: string;
};

type AliasAccumulator = {
  id: string;
  bestName: { value: string; score: number } | null;
};

type BuildDirectoryOptions = {
  maxPeers?: number;
  excludeIds?: string[];
};

const DEFAULT_MAX_PEERS = 250;
const MIN_PHONE_DIGITS = 6;
const MAX_PHONE_DIGITS = 15;

const normalizeText = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized;
};

const normalizePhoneDigits = (value: string): string | null => {
  const digits = value.replace(/[^\d]/g, "");
  if (digits.length < MIN_PHONE_DIGITS || digits.length > MAX_PHONE_DIGITS) {
    return null;
  }
  return `+${digits}`;
};

const normalizeWhatsAppDmTarget = (value: unknown): string | null => {
  const raw = normalizeText(value);
  if (!raw) {
    return null;
  }
  if (/@g\.us$/i.test(raw)) {
    return null;
  }
  const jidMatch = raw.match(/^(\d+)(?::\d+)?@(s\.whatsapp\.net|hosted|lid)$/i);
  if (jidMatch?.[1]) {
    return normalizePhoneDigits(jidMatch[1]);
  }
  if (/^\+?\d+$/.test(raw)) {
    return normalizePhoneDigits(raw);
  }
  return null;
};

const safeJsonArray = (raw: string | null): unknown[] => {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const asRecord = (value: unknown): Record<string, unknown> | null => {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
};

const upsertAlias = (
  aliases: Map<string, AliasAccumulator>,
  id: string,
  candidateName: string | null,
  score: number,
) => {
  const existing = aliases.get(id) ?? { id, bestName: null };
  if (candidateName && (!existing.bestName || score > existing.bestName.score)) {
    existing.bestName = { value: candidateName, score };
  }
  aliases.set(id, existing);
};

const extractIdFromContact = (contact: Record<string, unknown>): string | null => {
  const candidates = [
    contact.id,
    contact.jid,
    contact.lid,
    contact.waid,
    contact.number,
    contact.phone,
    contact.user,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeWhatsAppDmTarget(candidate);
    if (normalized) {
      return normalized;
    }
  }
  return null;
};

const extractIdFromChat = (chat: Record<string, unknown>): string | null => {
  return normalizeWhatsAppDmTarget(chat.id ?? chat.jid ?? chat.user ?? null);
};

const extractIdFromMessage = (message: Record<string, unknown>): string | null => {
  const key = asRecord(message.key);
  const remote = normalizeWhatsAppDmTarget(key?.remoteJid);
  if (remote) {
    return remote;
  }
  const participant = normalizeWhatsAppDmTarget(key?.participant);
  if (participant) {
    return participant;
  }
  return normalizeWhatsAppDmTarget(message.participant ?? message.from ?? null);
};

const collectContactAliases = (aliases: Map<string, AliasAccumulator>, contacts: unknown[]) => {
  for (const entry of contacts) {
    const contact = asRecord(entry);
    if (!contact) {
      continue;
    }
    const id = extractIdFromContact(contact);
    if (!id) {
      continue;
    }
    upsertAlias(aliases, id, normalizeText(contact.name), 100);
    upsertAlias(aliases, id, normalizeText(contact.notify), 90);
    upsertAlias(aliases, id, normalizeText(contact.verifiedName), 80);
    upsertAlias(aliases, id, normalizeText(contact.pushName), 70);
  }
};

const collectChatAliases = (aliases: Map<string, AliasAccumulator>, chats: unknown[]) => {
  for (const entry of chats) {
    const chat = asRecord(entry);
    if (!chat) {
      continue;
    }
    const id = extractIdFromChat(chat);
    if (!id) {
      continue;
    }
    upsertAlias(aliases, id, normalizeText(chat.name), 50);
    upsertAlias(aliases, id, normalizeText(chat.subject), 40);
  }
};

const collectMessageAliases = (aliases: Map<string, AliasAccumulator>, messages: unknown[]) => {
  for (const entry of messages) {
    const message = asRecord(entry);
    if (!message) {
      continue;
    }
    const id = extractIdFromMessage(message);
    if (!id) {
      continue;
    }
    upsertAlias(aliases, id, normalizeText(message.pushName), 35);
    upsertAlias(aliases, id, normalizeText(message.verifiedBizName), 30);
  }
};

const normalizeDirectoryPeers = (peers: WhatsAppDirectoryPeer[]): WhatsAppDirectoryPeer[] => {
  const dedup = new Map<string, WhatsAppDirectoryPeer>();
  for (const peer of peers) {
    const id = normalizeWhatsAppDmTarget(peer.id);
    if (!id) {
      continue;
    }
    const name = normalizeText(peer.name) ?? undefined;
    const handle = normalizeText(peer.handle) ?? undefined;
    const accountId = normalizeText(peer.accountId) ?? undefined;
    const current = dedup.get(id);
    if (!current) {
      dedup.set(id, { id, name, handle, accountId });
      continue;
    }
    dedup.set(id, {
      id,
      name: current.name ?? name,
      handle: current.handle ?? handle,
      accountId: current.accountId ?? accountId,
    });
  }
  return Array.from(dedup.values()).sort((a, b) => a.id.localeCompare(b.id));
};

export const buildWhatsAppDirectoryPeers = (
  profileData: ProfileDataRecord | null,
  options?: BuildDirectoryOptions,
): WhatsAppDirectoryPeer[] => {
  if (!profileData) {
    return [];
  }
  const contacts = safeJsonArray(profileData.contactsJson);
  const chats = safeJsonArray(profileData.chatsJson);
  const messages = safeJsonArray(profileData.messagesJson);

  const aliases = new Map<string, AliasAccumulator>();
  collectContactAliases(aliases, contacts);
  collectChatAliases(aliases, chats);
  collectMessageAliases(aliases, messages);

  const excluded = new Set(
    (options?.excludeIds ?? [])
      .map((value) => normalizeWhatsAppDmTarget(value))
      .filter((value): value is string => Boolean(value)),
  );

  const peers: WhatsAppDirectoryPeer[] = [];
  for (const alias of aliases.values()) {
    if (excluded.has(alias.id)) {
      continue;
    }
    peers.push({
      id: alias.id,
      name: alias.bestName?.value,
    });
  }
  const normalized = normalizeDirectoryPeers(peers);
  const maxPeers = options?.maxPeers && options.maxPeers > 0 ? options.maxPeers : DEFAULT_MAX_PEERS;
  return normalized.slice(0, maxPeers);
};
