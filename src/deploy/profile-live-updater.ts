import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DeployStore } from "./store.js";
import type { ProfileMessageEventRecord } from "./types.js";
import { refreshBootstrapFromArtifacts } from "./profile-bootstrap.js";

type LiveState = {
  lastProcessedOccurredAt?: string;
};

type SummarySweepState = {
  lastProcessedOccurredAt?: string;
};

type IncrementalUpdateParams = {
  userId: string;
  authDir: string;
  store: DeployStore;
};

type ConversationSummaryParams = {
  userId: string;
  peerId: string;
  dateKey: string;
  authDir: string;
  store: DeployStore;
  refreshBootstrap?: boolean;
};

type ConversationSummarySweepParams = {
  userId: string;
  authDir: string;
  store: DeployStore;
};

const MAX_INCREMENTAL_EVENTS = 120;
const MAX_SUMMARY_EVENTS = 800;
const MAX_SWEEP_EVENTS = 2_000;
const MAX_LINE_CHARS = 400;

const SUMMARY_STATE_FILENAME = "conversation-summary-state.json";
const PROFILE_STATE_FILENAME = "profile-live-state.json";

const STOPWORDS = new Set([
  "the", "and", "for", "that", "with", "this", "from", "have", "your", "you", "are", "was",
  "but", "not", "can", "just", "about", "what", "when", "where", "how", "who", "will", "would",
  "should", "could", "please", "thanks", "thank", "they", "them", "their", "then", "than", "into",
  "been", "were", "there", "here", "also", "need", "want", "like", "love", "prefer", "today",
  "tomorrow", "yesterday", "okay", "ok", "yes", "no", "got", "have", "has", "had", "our", "we",
  "me", "my", "i", "im", "its", "it", "a", "an", "to", "of", "in", "on", "at", "is", "as",
]);

const safeReadUtf8 = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
};

const safeReadJson = async <T>(filePath: string): Promise<T | null> => {
  const raw = await safeReadUtf8(filePath);
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const normalizeLine = (line: string): string => line.replace(/\s+/g, " ").trim();

const toDateKey = (date: Date): string => date.toISOString().slice(0, 10);

const toTimePart = (date: Date): string => date.toISOString().slice(11, 16);

const buildPeerSlug = (peerId: string): string => {
  const base = peerId.toLowerCase().replace(/[^a-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  const slug = base.length > 0 ? base.slice(0, 70) : "peer";
  const hash = createHash("sha1").update(peerId).digest("hex").slice(0, 8);
  return `${slug}-${hash}`;
};

const ensureDir = async (dirPath: string) => {
  await fs.mkdir(dirPath, { recursive: true });
};

const buildTranscriptLines = (events: ProfileMessageEventRecord[]): string[] => {
  return events.map((event) => {
    const role = event.direction === "outbound" ? "me" : "them";
    const content = normalizeLine(event.content).slice(0, MAX_LINE_CHARS);
    return `[${toTimePart(event.occurredAt)}][${role}] ${content}`;
  });
};

const addUnique = (target: string[], value: string) => {
  const normalized = normalizeLine(value);
  if (!normalized) {
    return;
  }
  if (!target.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) {
    target.push(normalized);
  }
};

const extractDurableNotes = (event: ProfileMessageEventRecord): string[] => {
  const notes: string[] = [];
  if (event.direction !== "inbound") {
    return notes;
  }

  const text = normalizeLine(event.content);
  if (!text) {
    return notes;
  }

  const peer = `Contact ${event.peerId}`;

  const callMe = text.match(/\b(?:call me|my name is)\s+([a-z][a-z .'-]{1,40})/i);
  if (callMe?.[1]) {
    addUnique(notes, `${peer} prefers to be called "${normalizeLine(callMe[1])}".`);
  }

  const livesIn = text.match(/\b(?:i live in|i am in|i'm in)\s+([^,.!?]{2,60})/i);
  if (livesIn?.[1]) {
    addUnique(notes, `${peer} location hint: ${normalizeLine(livesIn[1])}.`);
  }

  const worksAt = text.match(/\b(?:i work at|i work for|my company is)\s+([^,.!?]{2,80})/i);
  if (worksAt?.[1]) {
    addUnique(notes, `${peer} work context: ${normalizeLine(worksAt[1])}.`);
  }

  const preference = text.match(/\b(?:i like|i love|i prefer)\s+([^.!?]{2,80})/i);
  if (preference?.[1]) {
    addUnique(notes, `${peer} preference: ${normalizeLine(preference[1])}.`);
  }

  if (/\b(meeting|deadline|appointment|flight|trip|remind|tomorrow|next week|next month)\b/i.test(text)) {
    addUnique(notes, `${peer} planning signal: "${text.slice(0, 180)}"`);
  }

  return notes;
};

const extractKeywords = (events: ProfileMessageEventRecord[]): string[] => {
  const counts = new Map<string, number>();
  for (const event of events) {
    const words = normalizeLine(event.content)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((word) => word.length >= 4 && !STOPWORDS.has(word));
    for (const word of words) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([word]) => word);
};

const dayBounds = (dateKey: string): { from: Date; to: Date } => {
  const from = new Date(`${dateKey}T00:00:00.000Z`);
  const to = new Date(`${dateKey}T23:59:59.999Z`);
  return { from, to };
};

export const appendConversationLogEntry = async (
  authDir: string,
  event: Pick<ProfileMessageEventRecord, "peerId" | "direction" | "content" | "occurredAt">,
): Promise<string> => {
  const dateKey = toDateKey(event.occurredAt);
  const slug = buildPeerSlug(event.peerId);
  const dayDir = path.join(authDir, "memory", "conversations", dateKey);
  await ensureDir(dayDir);
  const logPath = path.join(dayDir, `${slug}.log.md`);
  const role = event.direction === "outbound" ? "me" : "them";
  const content = normalizeLine(event.content).slice(0, MAX_LINE_CHARS);
  const line = `- [${toTimePart(event.occurredAt)}][${role}] ${content}\n`;
  await fs.appendFile(logPath, line, "utf-8");
  return logPath;
};

export const runIncrementalProfileUpdate = async (
  params: IncrementalUpdateParams,
): Promise<{ updated: boolean; processedEvents: number; addedNotes: number }> => {
  const memoryDir = path.join(params.authDir, "memory");
  await ensureDir(memoryDir);
  const notesPath = path.join(memoryDir, "profile-live-notes.md");
  const statePath = path.join(memoryDir, PROFILE_STATE_FILENAME);
  const existingNotes = (await safeReadUtf8(notesPath)) ?? "";
  const state = (await safeReadJson<LiveState>(statePath)) ?? {};
  const from = state.lastProcessedOccurredAt ? new Date(state.lastProcessedOccurredAt) : undefined;

  const events = await params.store.listProfileMessageEvents({
    userId: params.userId,
    channel: "whatsapp",
    from,
    limit: MAX_INCREMENTAL_EVENTS,
  });
  const newEvents = from
    ? events.filter((event) => event.occurredAt.getTime() > from.getTime())
    : events;

  if (newEvents.length === 0) {
    return { updated: false, processedEvents: 0, addedNotes: 0 };
  }

  const candidateNotes = newEvents.flatMap((event) => extractDurableNotes(event));

  const existingLines = new Set(
    existingNotes
      .split("\n")
      .map((line) => line.replace(/^[-*]\s*/, "").trim().toLowerCase())
      .filter(Boolean),
  );

  const uniqueNotes = candidateNotes.filter((line) => !existingLines.has(line.toLowerCase()));

  if (uniqueNotes.length > 0) {
    const heading = `\n\n## ${new Date().toISOString()}\n`;
    const content = `${heading}${uniqueNotes.map((line) => `- ${line}`).join("\n")}\n`;
    await fs.appendFile(notesPath, content, "utf-8");
    await refreshBootstrapFromArtifacts(params.authDir);
  }

  const lastOccurredAt = newEvents[newEvents.length - 1]?.occurredAt ?? new Date();
  await fs.writeFile(
    statePath,
    JSON.stringify({ lastProcessedOccurredAt: lastOccurredAt.toISOString() }, null, 2),
    "utf-8",
  );

  return {
    updated: uniqueNotes.length > 0,
    processedEvents: newEvents.length,
    addedNotes: uniqueNotes.length,
  };
};

export const summarizeConversationDay = async (
  params: ConversationSummaryParams,
): Promise<{ updated: boolean; summaryPath?: string }> => {
  const { from, to } = dayBounds(params.dateKey);
  const events = await params.store.listProfileMessageEvents({
    userId: params.userId,
    channel: "whatsapp",
    peerId: params.peerId,
    from,
    to,
    limit: MAX_SUMMARY_EVENTS,
  });
  if (events.length === 0) {
    return { updated: false };
  }

  const inbound = events.filter((event) => event.direction === "inbound").length;
  const outbound = events.length - inbound;
  const transcriptLines = buildTranscriptLines(events);
  const recentHighlights = transcriptLines.slice(-12).map((line) => `- ${line}`);

  const planningSignals = events
    .filter((event) => /\b(meeting|deadline|appointment|flight|trip|remind|tomorrow|next week|next month)\b/i.test(event.content))
    .slice(-6)
    .map((event) => `- ${normalizeLine(event.content).slice(0, 180)}`);

  const preferences = events
    .filter((event) => /\b(i like|i love|i prefer|favorite|favourite)\b/i.test(event.content))
    .slice(-6)
    .map((event) => `- ${normalizeLine(event.content).slice(0, 180)}`);

  const keywords = extractKeywords(events);

  const summary = [
    `# Conversation Summary (${params.dateKey})`,
    "",
    `- Peer: \`${params.peerId}\``,
    `- Messages: ${events.length} (inbound ${inbound}, outbound ${outbound})`,
    "",
    "## Key topics",
    ...(keywords.length > 0 ? keywords.map((keyword) => `- ${keyword}`) : ["- No strong recurring keywords captured."]),
    "",
    "## Decisions / commitments",
    ...(planningSignals.length > 0 ? planningSignals : ["- No explicit commitments detected."]),
    "",
    "## Follow-ups",
    ...(planningSignals.length > 0 ? planningSignals : ["- No explicit follow-up requests detected."]),
    "",
    "## Personal signals",
    ...(preferences.length > 0 ? preferences : ["- No clear preference statements detected."]),
    "",
    "## Recent highlights",
    ...(recentHighlights.length > 0 ? recentHighlights : ["- No recent highlights available."]),
    "",
  ].join("\n");

  const slug = buildPeerSlug(params.peerId);
  const dir = path.join(params.authDir, "memory", "conversations", params.dateKey);
  await ensureDir(dir);
  const summaryPath = path.join(dir, `${slug}.summary.md`);
  await fs.writeFile(summaryPath, summary, "utf-8");

  if (params.refreshBootstrap !== false) {
    await refreshBootstrapFromArtifacts(params.authDir);
  }

  return { updated: true, summaryPath };
};

export const runConversationSummarySweep = async (
  params: ConversationSummarySweepParams,
): Promise<{ updatedSummaries: number; processedEvents: number }> => {
  const memoryDir = path.join(params.authDir, "memory");
  await ensureDir(memoryDir);
  const statePath = path.join(memoryDir, SUMMARY_STATE_FILENAME);
  const state = (await safeReadJson<SummarySweepState>(statePath)) ?? {};
  const from = state.lastProcessedOccurredAt ? new Date(state.lastProcessedOccurredAt) : undefined;

  const events = await params.store.listProfileMessageEvents({
    userId: params.userId,
    channel: "whatsapp",
    from,
    limit: MAX_SWEEP_EVENTS,
  });

  const newEvents = from
    ? events.filter((event) => event.occurredAt.getTime() > from.getTime())
    : events;

  if (newEvents.length === 0) {
    return { updatedSummaries: 0, processedEvents: 0 };
  }

  const targets = new Map<string, { peerId: string; dateKey: string }>();
  for (const event of newEvents) {
    const dateKey = toDateKey(event.occurredAt);
    const key = `${dateKey}:${event.peerId}`;
    targets.set(key, { peerId: event.peerId, dateKey });
  }

  const sortedTargets = Array.from(targets.values()).sort(
    (a, b) => a.dateKey.localeCompare(b.dateKey) || a.peerId.localeCompare(b.peerId),
  );

  let updatedSummaries = 0;
  for (const target of sortedTargets) {
    const result = await summarizeConversationDay({
      userId: params.userId,
      peerId: target.peerId,
      dateKey: target.dateKey,
      authDir: params.authDir,
      store: params.store,
      refreshBootstrap: false,
    });
    if (result.updated) {
      updatedSummaries += 1;
    }
  }

  if (updatedSummaries > 0) {
    await refreshBootstrapFromArtifacts(params.authDir);
  }

  const lastOccurredAt = newEvents[newEvents.length - 1]?.occurredAt ?? new Date();
  await fs.writeFile(
    statePath,
    JSON.stringify({ lastProcessedOccurredAt: lastOccurredAt.toISOString() }, null, 2),
    "utf-8",
  );

  return {
    updatedSummaries,
    processedEvents: newEvents.length,
  };
};
