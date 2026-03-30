import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function readTopiclabCliPackageVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const pkgPath = path.join(here, "..", "package.json");
  const raw = fs.readFileSync(pkgPath, "utf8");
  const pkg = JSON.parse(raw) as { version?: string };
  return typeof pkg.version === "string" && pkg.version.trim() ? pkg.version.trim() : "0.0.0";
}
