import { existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

export function loadEnv(): void {
  const path = join(ROOT, ".env");
  if (existsSync(path)) process.loadEnvFile(path);
}

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. Copy .env.example to .env and fill it in.`);
  return value;
}
