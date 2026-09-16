// Prompt attachment API (agentic-coding-harness#12).
//
// Attaches files to a prompt: reads each file, enforces a configurable total
// byte cap, appends the contents in a clearly-delimited block after the base
// prompt, and returns a manifest ({path, sha256} per file) plus a sha256 of
// the final composed prompt. The driver calls composePrompt() when RunSpec
// carries `attachments`; the helper is also exported standalone for direct use.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { HarnessError } from './types.js';

/** Default total byte cap across all attached files: 1 MiB. */
export const DEFAULT_MAX_ATTACHMENT_BYTES = 1024 * 1024;

/** One attached file as recorded in the manifest. */
export interface AttachmentFile {
  /** Path exactly as given by the caller (not resolved). */
  path: string;
  /** Hex sha256 of the file's raw bytes. */
  sha256: string;
  /** Size of the file in bytes. */
  bytes: number;
}

/** What was attached and how the final prompt hashes. */
export interface AttachmentManifest {
  files: AttachmentFile[];
  /** Hex sha256 of the final composed prompt string. */
  promptSha256: string;
  /** Total attached file bytes (contents only, delimiters excluded). */
  totalBytes: number;
}

export interface ComposePromptOptions {
  /** Total byte cap across all attached files (default 1 MiB). */
  maxTotalBytes?: number;
  /** Base directory for relative attachment paths (default: no resolution). */
  cwd?: string;
}

export interface ComposePromptResult {
  /** Base prompt + delimited file blocks; this is what the agent receives. */
  prompt: string;
  manifest: AttachmentManifest;
}

const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/**
 * Compose a prompt with file attachments.
 *
 * Each file's bytes count toward the total cap; exceeding it throws a
 * HarnessError (code PROMPT_ATTACHMENT_CAP) before any prompt is built. Files
 * are appended in the order given, each wrapped in BEGIN/END delimiters that
 * carry the path and sha256 so the agent (and any reader) can cite provenance.
 */
export async function composePrompt(
  prompt: string,
  files: readonly string[],
  opts: ComposePromptOptions = {},
): Promise<ComposePromptResult> {
  const maxTotalBytes = opts.maxTotalBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
  const resolve = (p: string): string => (opts.cwd && !isAbsolute(p) ? join(opts.cwd, p) : p);

  const attached: AttachmentFile[] = [];
  const blocks: string[] = [];
  let totalBytes = 0;

  for (const path of files) {
    let content: Buffer;
    try {
      content = await readFile(resolve(path));
    } catch (err) {
      throw new HarnessError(
        `attachments: failed to read "${path}": ${err instanceof Error ? err.message : String(err)}`,
        'PROMPT_ATTACHMENT_READ',
      );
    }
    const sha256 = sha256Hex(content);
    totalBytes += content.byteLength;
    if (totalBytes > maxTotalBytes) {
      throw new HarnessError(
        `attachments: total ${totalBytes} bytes exceeds the ${maxTotalBytes}-byte cap (file "${path}" pushed it over)`,
        'PROMPT_ATTACHMENT_CAP',
      );
    }
    attached.push({ path, sha256, bytes: content.byteLength });
    const text = content.toString('utf8');
    const body = text.endsWith('\n') ? text : `${text}\n`;
    blocks.push(
      `-----BEGIN ATTACHED FILE: ${path} (sha256=${sha256}, bytes=${content.byteLength})-----\n${body}-----END ATTACHED FILE: ${path}-----`,
    );
  }

  const composed = blocks.length === 0 ? prompt : `${prompt}\n\n${blocks.join('\n\n')}`;
  return {
    prompt: composed,
    manifest: {
      files: attached,
      promptSha256: sha256Hex(composed),
      totalBytes,
    },
  };
}
