import fs from "node:fs/promises";
import path from "node:path";

const MAX_RECENT_SUMMARY_FILES = 3;
const MAX_SUMMARY_SNIPPET_CHARS = 800;
const MAX_LIVE_NOTES_CHARS = 8_000;

const readUtf8 = async (filePath: string): Promise<string | null> => {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
};

const listRecentConversationSummaryFiles = async (authDir: string): Promise<string[]> => {
  const root = path.join(authDir, "memory", "conversations");
  let dateDirs: string[] = [];
  try {
    dateDirs = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const dateDir of dateDirs) {
    const fullDir = path.join(root, dateDir);
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(fullDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".summary.md"))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    entries.sort().reverse();
    for (const entry of entries) {
      files.push(path.join(fullDir, entry));
      if (files.length >= MAX_RECENT_SUMMARY_FILES) {
        return files;
      }
    }
  }
  return files;
};

const buildRecentSummarySection = async (authDir: string): Promise<string | null> => {
  const files = await listRecentConversationSummaryFiles(authDir);
  if (files.length === 0) {
    return null;
  }

  const lines: string[] = [];
  for (const filePath of files) {
    const content = await readUtf8(filePath);
    if (!content) {
      continue;
    }
    const rel = path.relative(path.join(authDir, "memory"), filePath).replace(/\\/g, "/");
    const snippet = content.replace(/\s+/g, " ").trim().slice(0, MAX_SUMMARY_SNIPPET_CHARS);
    if (!snippet) {
      continue;
    }
    lines.push(`- \`${rel}\`: ${snippet}`);
  }
  if (lines.length === 0) {
    return null;
  }
  return `### Recent conversation summaries\n${lines.join("\n")}`;
};

const trimToRecentChars = (value: string, maxChars: number): string => {
  const normalized = value.trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `...\n${normalized.slice(normalized.length - maxChars)}`;
};

export const refreshBootstrapFromArtifacts = async (
  authDir: string,
  options?: { profileMdOverride?: string },
): Promise<void> => {
  const memoryDir = path.join(authDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });

  const profileMd =
    options?.profileMdOverride ??
    (await readUtf8(path.join(memoryDir, "user-profile.md"))) ??
    "Profile not yet available.";
  const liveNotes = await readUtf8(path.join(memoryDir, "profile-live-notes.md"));
  const recentSummaries = await buildRecentSummarySection(authDir);

  const parts: string[] = [`### What you know about this person\n\n${profileMd.trim()}`];
  if (liveNotes && liveNotes.trim().length > 0) {
    parts.push(`### Incremental profile updates\n\n${trimToRecentChars(liveNotes, MAX_LIVE_NOTES_CHARS)}`);
  }
  if (recentSummaries) {
    parts.push(recentSummaries);
  }

  const bootstrapPath = path.join(authDir, "BOOTSTRAP.md");
  await fs.writeFile(bootstrapPath, `${parts.join("\n\n")}\n`, "utf-8");
};
