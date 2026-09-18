// Single source for the package version. Reads package.json once at module
// load; the literal fallback only fires in bundled/standalone builds where
// the file layout is gone (keep it in sync at release time).

import { readFileSync } from "node:fs";

function loadVersion(): string {
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof v === "string" && v !== "") return v;
  } catch {
    // bundled/standalone: fall through to the release-time literal
  }
  return "0.9.0";
}

export const VERSION: string = loadVersion();
