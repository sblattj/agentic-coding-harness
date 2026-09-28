// Read-only Qwen Code chat parser.
//
// Where: ~/.qwen/projects/<sanitized-cwd>/chats/<sessionId>.jsonl
//   (QwenLM/qwen-code @ 3124af5b: packages/core/src/config/storage.ts
//   getProjectDir() = <runtimeBaseDir>/projects/<sanitizeCwd(root)>, and
//   packages/core/src/services/chatRecordingService.ts ensureConversationFile()
//   = <projectDir>/chats/<sessionId>.jsonl. The class JSDoc there still says
//   ~/.qwen/tmp/<project_id>/chats — stale; the code is authoritative.)
//
// NOT the Gemini CLI chat JSON: qwen-code forked gemini-cli but records chats
// as append-only JSONL ChatRecords. Only `type: "assistant"` records carry
// `usageMetadata` (a @google/genai GenerateContentResponseUsageMetadata).
//
// Accounting:
//  - cachedContentTokenCount is a subset of promptTokenCount (Gemini API
//    semantics; qwen's OpenAI converter fills promptTokenCount from
//    prompt_tokens, which also includes cached_tokens) -> input = prompt - cached.
//  - thoughtsTokenCount: on the OpenAI-converted path candidatesTokenCount is
//    completion_tokens, which already INCLUDES reasoning; on a Gemini-native
//    path candidates EXCLUDES thoughts. totalTokenCount arbitrates: if
//    total >= prompt + candidates + thoughts (thoughts > 0) the thoughts are
//    additive and are folded into output; otherwise output = candidates.
//    reasoning = thoughts either way (a subset of output, canonical rule).
//  - a record with only totalTokenCount (no prompt/candidates split) is
//    skipped with a warning; cache writes are not reported (0).

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { CanonicalTokenRecord } from "./transcripts.ts";
import { warnTranscript, type WarnFn } from "./transcript-warnings.ts";

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : 0);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);

export async function parseQwenChat(
  path: string,
  warn: WarnFn = warnTranscript,
): Promise<CanonicalTokenRecord[]> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    warn(`qwen: skipped unreadable chat file ${path}: ${(err as Error).message}`);
    return [];
  }
  const stem = basename(path, extname(path));
  const out: CanonicalTokenRecord[] = [];
  const lines = text.replace(/^﻿/, "").split("\n");
  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      warn(`qwen: ${path}: skipped line ${i + 1} (invalid JSON)`);
      return;
    }
    if (!isObj(rec) || rec.type !== "assistant" || !isObj(rec.usageMetadata)) return;
    const u = rec.usageMetadata;
    const prompt = num(u.promptTokenCount);
    const candidates = num(u.candidatesTokenCount);
    const thoughts = num(u.thoughtsTokenCount);
    const cached = Math.min(num(u.cachedContentTokenCount), prompt);
    const total = num(u.totalTokenCount);
    if (prompt === 0 && candidates === 0) {
      if (total > 0) {
        warn(`qwen: ${path}: skipped line ${i + 1}: only totalTokenCount (${total}), no prompt/candidates split`);
      }
      return;
    }
    const thoughtsAdditive = thoughts > 0 && total >= prompt + candidates + thoughts;
    out.push({
      agent: "qwen",
      sessionId: str(rec.sessionId) ?? stem,
      timestamp: str(rec.timestamp),
      model: str(rec.model),
      input: prompt - cached,
      output: thoughtsAdditive ? candidates + thoughts : candidates,
      cacheRead: cached,
      cacheWrite: 0,
      reasoning: thoughts,
    });
  });
  return out;
}
