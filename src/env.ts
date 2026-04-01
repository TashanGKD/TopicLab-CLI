import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

let loaded = false;

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function parseDotenvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return null;
  }
  const separator = trimmed.indexOf("=");
  if (separator <= 0) {
    return null;
  }
  const key = trimmed.slice(0, separator).trim();
  const rawValue = trimmed.slice(separator + 1).trim();
  if (!key) {
    return null;
  }
  return [key, stripQuotes(rawValue)];
}

function candidateEnvPaths(): string[] {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  return [
    path.resolve(moduleDir, "..", ".env"),
    path.resolve(process.cwd(), ".env"),
  ];
}

export function loadBundledEnv(): void {
  if (loaded) {
    return;
  }
  loaded = true;
  if (process.env.TOPICLAB_DISABLE_BUNDLED_ENV === "1" || process.env.VITEST) {
    return;
  }

  for (const envPath of candidateEnvPaths()) {
    if (!fs.existsSync(envPath)) {
      continue;
    }
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseDotenvLine(line);
      if (!parsed) {
        continue;
      }
      const [key, value] = parsed;
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  }
}

loadBundledEnv();
