import fs from "node:fs/promises";
import path from "node:path";
import type { DeployStore } from "./store.js";
import type { ModelTier } from "./types.js";

// ---------------------------------------------------------------------------
// Model resolution (mirrors provisioner-docker.ts tiers so profile synthesis
// uses the same model family the user's agent uses)
// ---------------------------------------------------------------------------

// How many items to pull from the WhatsApp store per field.
// Larger models with more context get more data → better profile.
type DataLimits = {
  maxContacts: number;
  maxChats: number;
  maxMessages: number;
};

const LIMITS_SMALL: DataLimits = { maxContacts: 100, maxChats: 80, maxMessages: 150 };
const LIMITS_MEDIUM: DataLimits = { maxContacts: 200, maxChats: 150, maxMessages: 500 };
const LIMITS_LARGE: DataLimits = { maxContacts: 500, maxChats: 300, maxMessages: 2000 };

type LlmProvider = {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Controls how much WhatsApp data is fed into the prompt. */
  limits: DataLimits;
};

// ---------------------------------------------------------------------------
// Prioritise free, capable models; fall back to paid only as last resort.
//
// best/premium:  Nvidia Kimi K2.5 (free, 671B, best coding) →
//                Google Gemini Flash (free, 1M ctx, sends 10x more data) →
//                Groq 70B (free*, fast) → OpenAI gpt-4o-mini (cheap last resort)
//
// fast:          Google Gemini Flash (free, fast) →
//                Groq 8B (free*, ultra-fast) → OpenAI gpt-4o-mini
// ---------------------------------------------------------------------------

const resolveProvider = (modelTier: ModelTier | undefined): LlmProvider | null => {
  const groqKey = process.env.GROQ_API_KEY?.trim();
  const nvidiaKey = process.env.NVIDIA_API_KEY?.trim();
  const googleKey = process.env.GOOGLE_API_KEY?.trim();
  const openaiKey = process.env.OPENAI_API_KEY?.trim();

  // eslint-disable-next-line no-console
  console.log(
    `[synthesizer] key availability: NVIDIA=${!!nvidiaKey} GOOGLE=${!!googleKey} ` +
    `GROQ=${!!groqKey} OPENAI=${!!openaiKey} tier=${modelTier ?? "best"}`,
  );

  if (modelTier === "fast") {
    // Gemini Flash is the best free fast model — 1M context, smarter than 8B
    if (googleKey) {
      const p: LlmProvider = {
        baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
        apiKey: googleKey,
        model: "gemini-2.0-flash",
        limits: LIMITS_LARGE,
      };
      // eslint-disable-next-line no-console
      console.log(`[synthesizer] selected provider: google model=${p.model} limits=large`);
      return p;
    }
    if (groqKey) {
      const p: LlmProvider = {
        baseUrl: "https://api.groq.com/openai/v1",
        apiKey: groqKey,
        model: "llama-3.1-8b-instant",
        limits: LIMITS_SMALL,
      };
      // eslint-disable-next-line no-console
      console.log(`[synthesizer] selected provider: groq model=${p.model} limits=small`);
      return p;
    }
    if (nvidiaKey) {
      const p: LlmProvider = {
        baseUrl: "https://integrate.api.nvidia.com/v1",
        apiKey: nvidiaKey,
        model: "nvidia/llama-3.1-nemotron-nano-8b-v1",
        limits: LIMITS_SMALL,
      };
      // eslint-disable-next-line no-console
      console.log(`[synthesizer] selected provider: nvidia model=${p.model} limits=small`);
      return p;
    }
    if (openaiKey) {
      const p: LlmProvider = {
        baseUrl: "https://api.openai.com/v1",
        apiKey: openaiKey,
        model: "gpt-4o-mini",
        limits: LIMITS_SMALL,
      };
      // eslint-disable-next-line no-console
      console.log(`[synthesizer] selected provider: openai model=${p.model} limits=small`);
      return p;
    }
  }

  // best / premium — Kimi K2.5 first (best at social analysis + coding),
  // then Gemini Flash (more data fits in its 1M context window),
  // then Groq 70B, finally OpenAI mini as cheap last resort.
  if (nvidiaKey) {
    const p: LlmProvider = {
      baseUrl: "https://integrate.api.nvidia.com/v1",
      apiKey: nvidiaKey,
      model: "moonshotai/kimi-k2.5",
      limits: LIMITS_MEDIUM,
    };
    // eslint-disable-next-line no-console
    console.log(`[synthesizer] selected provider: nvidia model=${p.model} limits=medium`);
    return p;
  }
  if (googleKey) {
    const p: LlmProvider = {
      baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
      apiKey: googleKey,
      model: "gemini-2.0-flash",
      limits: LIMITS_LARGE,
    };
    // eslint-disable-next-line no-console
    console.log(`[synthesizer] selected provider: google model=${p.model} limits=large`);
    return p;
  }
  if (groqKey) {
    const p: LlmProvider = {
      baseUrl: "https://api.groq.com/openai/v1",
      apiKey: groqKey,
      model: "llama-3.3-70b-versatile",
      limits: LIMITS_MEDIUM,
    };
    // eslint-disable-next-line no-console
    console.log(`[synthesizer] selected provider: groq model=${p.model} limits=medium`);
    return p;
  }
  if (openaiKey) {
    const p: LlmProvider = {
      baseUrl: "https://api.openai.com/v1",
      apiKey: openaiKey,
      model: "gpt-4o-mini",
      limits: LIMITS_SMALL,
    };
    // eslint-disable-next-line no-console
    console.log(`[synthesizer] selected provider: openai model=${p.model} limits=small`);
    return p;
  }
  // eslint-disable-next-line no-console
  console.warn("[synthesizer] no LLM keys configured — profile synthesis will be skipped");
  return null;
};

// ---------------------------------------------------------------------------
// Data preparation — compact summaries to fit in context
// ---------------------------------------------------------------------------

const safeJson = (json: string | null): unknown[] => {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const extractContactName = (contact: unknown): string | null => {
  if (!contact || typeof contact !== "object") return null;
  const c = contact as Record<string, unknown>;
  return (
    (typeof c.name === "string" && c.name.trim()) ||
    (typeof c.notify === "string" && c.notify.trim()) ||
    (typeof c.verifiedName === "string" && c.verifiedName.trim()) ||
    null
  );
};

const extractChatSummary = (chat: unknown): string | null => {
  if (!chat || typeof chat !== "object") return null;
  const c = chat as Record<string, unknown>;
  const name = (typeof c.name === "string" && c.name.trim()) || null;
  if (!name) return null;
  // Try to pull the last message text from the chat object (Baileys includes it)
  const lastMsg = c.lastMessage as Record<string, unknown> | undefined;
  const lastText = lastMsg ? extractMessageText(lastMsg) : null;
  return lastText ? `${name}: "${lastText.slice(0, 120)}"` : name;
};

const extractMessageText = (msg: unknown): string | null => {
  if (!msg || typeof msg !== "object") return null;
  const m = msg as Record<string, unknown>;
  // Baileys message structure: msg.message.conversation or msg.message.extendedTextMessage.text
  const inner = m.message as Record<string, unknown> | undefined;
  if (!inner) return null;
  if (typeof inner.conversation === "string") return inner.conversation;
  const ext = inner.extendedTextMessage as Record<string, unknown> | undefined;
  if (typeof ext?.text === "string") return ext.text;
  return null;
};

const isOutbound = (msg: unknown): boolean => {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return m.key !== undefined &&
    typeof (m.key as Record<string, unknown>)?.fromMe === "boolean" &&
    (m.key as Record<string, unknown>)?.fromMe === true;
};

const buildDataSummary = (
  displayName: string | null,
  phone: string,
  contactsJson: string | null,
  chatsJson: string | null,
  messagesJson: string | null,
  limits: DataLimits,
): string => {
  const contacts = safeJson(contactsJson);
  const chats = safeJson(chatsJson);
  const messages = safeJson(messagesJson);

  const parts: string[] = [];

  parts.push(`## User identity\n- Display name: ${displayName ?? "(unknown)"}\n- Phone: ${phone}`);

  if (contacts.length > 0) {
    const names = contacts
      .map(extractContactName)
      .filter((n): n is string => Boolean(n))
      .slice(0, limits.maxContacts);
    parts.push(`## Contacts (${names.length} of ${contacts.length} shown)\n${names.map((n) => `- ${n}`).join("\n")}`);
  }

  if (chats.length > 0) {
    const chatSummaries = chats
      .map(extractChatSummary)
      .filter((n): n is string => Boolean(n))
      .slice(0, limits.maxChats);
    parts.push(`## Chats (${chatSummaries.length} of ${chats.length} shown)\n${chatSummaries.map((n) => `- ${n}`).join("\n")}`);
  }

  if (messages.length > 0) {
    const msgLines: string[] = [];
    let count = 0;
    for (const msg of messages) {
      if (count >= limits.maxMessages) break;
      const text = extractMessageText(msg);
      if (!text || text.trim().length === 0) continue;
      const role = isOutbound(msg) ? "me" : "them";
      msgLines.push(`[${role}]: ${text.trim().slice(0, 300)}`);
      count++;
    }
    if (msgLines.length > 0) {
      parts.push(`## Recent messages (${msgLines.length} shown)\n${msgLines.join("\n")}`);
    }
  }

  return parts.join("\n\n");
};

// ---------------------------------------------------------------------------
// LLM call
// ---------------------------------------------------------------------------

const callLlm = async (provider: LlmProvider, userPrompt: string, label: string): Promise<string> => {
  // eslint-disable-next-line no-console
  console.log(`[synthesizer] calling LLM for ${label}: model=${provider.model} promptLen=${userPrompt.length}`);
  const systemPrompt = `You are building a personal profile for an AI assistant who will talk to this person daily.
Your task: analyze the WhatsApp data below and write a Markdown profile that the assistant will use as context.

CRITICAL RULES:
1. You MUST produce a profile regardless of how much or how little data you have.
2. NEVER say you need more data, chat exports, or anything else. Work with what is given.
3. NEVER ask the user to provide anything. Just write the profile.
4. If a section has no evidence, skip it entirely — do not mention the absence.
5. From contact names and chat names alone you can infer: language(s), cultural background, relationship types (family group chats, work contacts), social circle breadth, and more. Use this.
6. Be specific. Use actual names you see. Avoid vague filler like "has various contacts."

Profile sections (only include sections where you have real evidence):
- **Identity**: Name, phone, inferred language(s), estimated timezone/region
- **Relationships**: people who appear — family, friends, colleagues (use names)
- **Social & Communication**: group chats, conversation style inferred from message snippets
- **Work & Professional Life**: anything suggesting job, company, role
- **Interests & Context**: topics, recurring themes visible in chat names or messages
- **Notes**: anything useful that doesn't fit above

Write in third person ("Agu is…"). Be concise and factual. This profile will be prepended to the assistant's system prompt.`;

  const response = await fetch(`${provider.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify({
      model: provider.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 2048,
      temperature: 0.3,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const msg = `LLM API error ${response.status} (${provider.model}): ${body.slice(0, 300)}`;
    // eslint-disable-next-line no-console
    console.error(`[synthesizer] ${msg}`);
    throw new Error(msg);
  }

  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    // eslint-disable-next-line no-console
    console.error(`[synthesizer] LLM returned empty content from ${provider.model}`);
    throw new Error("LLM returned empty content");
  }
  // eslint-disable-next-line no-console
  console.log(`[synthesizer] LLM response received: model=${provider.model} outputLen=${content.length}`);
  return content.trim();
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const synthesizeUserProfile = async (
  userId: string,
  whatsappId: string,
  authDir: string,
  modelTier: ModelTier | undefined,
  store: DeployStore,
  caller = "unknown",
): Promise<void> => {
  // eslint-disable-next-line no-console
  console.log(`[synthesizer] starting profile synthesis for userId=${userId} tier=${modelTier ?? "best"} caller=${caller}`);

  const provider = resolveProvider(modelTier);
  if (!provider) {
    // eslint-disable-next-line no-console
    console.warn(`[synthesizer] skipping synthesis for userId=${userId}: no LLM provider available`);
    return;
  }

  const profileData = await store.getProfileData(userId);
  if (!profileData) {
    // eslint-disable-next-line no-console
    console.warn(`[synthesizer] skipping synthesis for userId=${userId}: no profile data in store yet`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[synthesizer] profile data found for userId=${userId} displayName=${profileData.displayName ?? "(none)"}`);

  const summary = buildDataSummary(
    profileData.displayName,
    whatsappId,
    profileData.contactsJson,
    profileData.chatsJson,
    profileData.messagesJson,
    provider.limits,
  );

  if (summary.trim().length === 0) {
    // eslint-disable-next-line no-console
    console.warn(`[synthesizer] skipping synthesis for userId=${userId}: data summary is empty`);
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[synthesizer] built data summary for userId=${userId} summaryLen=${summary.length}`);

  const userPrompt = `Here is the WhatsApp data for the person you will be assisting:\n\n${summary}\n\nPlease build their profile now.`;

  const profileMd = await callLlm(provider, userPrompt, `userId=${userId}`);

  // Write to the memory directory so OpenClaw's memory system and the plugin can read it
  const memoryDir = path.join(authDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  const profilePath = path.join(memoryDir, "user-profile.md");
  await fs.writeFile(profilePath, profileMd, "utf-8");
  // eslint-disable-next-line no-console
  console.log(`[synthesizer] profile written to ${profilePath} (${profileMd.length} chars) for userId=${userId}`);

  // Persist to DB as backup
  await store.upsertProfileMd(userId, profileMd);
  // eslint-disable-next-line no-console
  console.log(`[synthesizer] profile synthesis complete for userId=${userId}`);
};

// ---------------------------------------------------------------------------
// Incremental update — called when the agent sends an agent_note event
// or when a batch of new messages accumulates
// ---------------------------------------------------------------------------

export const appendAgentNoteToProfile = async (
  authDir: string,
  note: string,
): Promise<void> => {
  const profilePath = path.join(authDir, "memory", "user-profile.md");
  let existing = "";
  try {
    existing = await fs.readFile(profilePath, "utf-8");
  } catch {
    // Profile may not exist yet
  }

  const timestamp = new Date().toISOString().slice(0, 10);
  const noteSection = `\n\n## Agent Notes\n- [${timestamp}] ${note.trim()}`;

  // If there's already an "Agent Notes" section, append to it; otherwise add the section
  const next = existing.includes("## Agent Notes")
    ? existing + `\n- [${timestamp}] ${note.trim()}`
    : existing + noteSection;

  await fs.mkdir(path.join(authDir, "memory"), { recursive: true });
  await fs.writeFile(profilePath, next, "utf-8");
};
