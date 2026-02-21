import type { ModelTier } from "./types.js";

export const GATEWAY_CONFIG_VERSION = "2026.02.21.1";
export const GATEWAY_PLUGIN_VERSION = "2026.02.21.1";
export const GATEWAY_RUNTIME_POLICY_VERSION = "2026.02.21.1";

export const DEFAULT_TOOLS_PROFILE = "full";
export const DEFAULT_TOOLS_ALSO_ALLOW = [
  "get_user_profile",
  "update_user_profile",
  "memory_search",
  "memory_get",
  "message",
] as const;

export const DEFAULT_GATEWAY_ROOT_DIR = "/data/auth";
export const DEFAULT_GATEWAY_WHATSAPP_AUTH_DIR = `${DEFAULT_GATEWAY_ROOT_DIR}/wa-session-data`;

export const DEFAULT_BROWSER_ENABLED = true;
export const DEFAULT_BROWSER_DEFAULT_PROFILE = "openclaw";
export const DEFAULT_BROWSER_HEADLESS = true;
export const DEFAULT_BROWSER_NO_SANDBOX = true;

// ---------------------------------------------------------------------------
// Model strategy (all free options prioritised first)
//
// best/premium: Kimi K2.5 (free 671B coding champion) -> Gemini Pro (free 1M ctx)
//               -> Gemini Flash (free, fast) -> Nemotron Ultra (free 253B)
//               -> Groq 70B (free*) -> GPT-4o-mini (cheap last resort)
//
// fast:         Gemini Flash (free, fast, smart 1M ctx) -> Groq 8B (free*, ultra-fast)
//               -> Nemotron Nano (free) -> GPT-4o-mini (cheap last resort)
//
// NOTE: Groq is not a native LLM provider in OpenClaw. It is configured as
// openai-completions so model IDs resolve consistently.
// ---------------------------------------------------------------------------

const MODEL_PRIMARY_BY_TIER: Record<ModelTier, string> = {
  best: "nvidia/moonshotai/kimi-k2.5",
  fast: "google/gemini-3-flash-preview",
  premium: "nvidia/moonshotai/kimi-k2.5",
};

const MODEL_FALLBACKS_BY_TIER: Record<ModelTier, string[]> = {
  best: [
    "google/gemini-3-pro-preview",
    "google/gemini-3-flash-preview",
    "nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1",
    "groq/llama-3.3-70b-versatile",
    "openai/gpt-4o-mini",
  ],
  fast: [
    "groq/llama-3.1-8b-instant",
    "nvidia/nvidia/llama-3.1-nemotron-nano-8b-v1",
    "openai/gpt-4o-mini",
  ],
  premium: [
    "google/gemini-3-pro-preview",
    "google/gemini-3-flash-preview",
    "nvidia/nvidia/llama-3.1-nemotron-ultra-253b-v1",
    "groq/llama-3.3-70b-versatile",
    "openai/gpt-4o-mini",
  ],
};

const MODEL_CONTEXT_TOKENS_BY_TIER: Record<ModelTier, number> = {
  best: 131_072,
  fast: 32_000,
  premium: 131_072,
};

export const resolvePrimaryModelForTier = (modelTier: ModelTier | undefined) =>
  MODEL_PRIMARY_BY_TIER[modelTier ?? "best"] ?? MODEL_PRIMARY_BY_TIER.best;

export const resolveModelFallbacksForTier = (modelTier: ModelTier | undefined) =>
  [...(MODEL_FALLBACKS_BY_TIER[modelTier ?? "best"] ?? MODEL_FALLBACKS_BY_TIER.best)];

export const resolveContextTokensForTier = (modelTier: ModelTier | undefined) =>
  MODEL_CONTEXT_TOKENS_BY_TIER[modelTier ?? "best"] ?? MODEL_CONTEXT_TOKENS_BY_TIER.best;

