import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";
import { deployConfig } from "./config.js";

const resolveMigrationsDir = () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, "migrations");
};

const readMigrationFiles = async () => {
  const dir = resolveMigrationsDir();
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".sql"))
    .map((entry) => entry.name)
    .sort();
  return files.map((name) => path.join(dir, name));
};

export const initDatabase = async () => {
  if (!deployConfig.databaseUrl) {
    return null;
  }
  const pool = new Pool({ connectionString: deployConfig.databaseUrl });
  await applyMigrations(pool);
  return pool;
};

export const applyMigrations = async (pool: Pool) => {
  const files = await readMigrationFiles();
  for (const filePath of files) {
    const sql = await fs.readFile(filePath, "utf-8");
    if (sql.trim().length === 0) {
      continue;
    }
    await pool.query(sql);
  }
};
