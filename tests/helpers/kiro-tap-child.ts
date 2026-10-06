// Child process for tests/kiro-mitm-multiproc.test.ts: one independent `ach`
// process starting a kiro run with the MITM tap. Prints one JSON line:
// { proxy: <HTTPS_PROXY the kiro child saw, or null>, stderr: <warnings> }.
// argv: <startAtEpochMs> <fakeMitmdump> <fakeKiroCli> <envDumpFile>
import { readFileSync } from 'node:fs';
import { KiroAdapter } from '../../src/adapters/kiro.js';

async function main(): Promise<void> {
  const [startAt, mitmdumpBin, kiroCli, envFile] = process.argv.slice(2) as [string, string, string, string];
  let stderr = '';
  const origWrite = process.stderr.write.bind(process.stderr);
  (process.stderr as unknown as { write: unknown }).write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  // Barrier: both processes begin the tap start at the same instant so their
  // port selection genuinely overlaps (the #114 race).
  while (Date.now() < Number(startAt)) await new Promise((r) => setTimeout(r, 1));
  const adapter = new KiroAdapter({ command: kiroCli, mitm: true, mitmdumpBin });
  const handle = await adapter.launch({ prompt: 'x', env: { FAKE_KIRO_ENV_FILE: envFile } });
  for await (const _event of handle.attach()) void _event;
  await handle.wait();
  let proxy: string | null = null;
  try {
    proxy = readFileSync(envFile, 'utf8').match(/^HTTPS_PROXY=(.*)$/m)?.[1] ?? null;
  } catch {
    proxy = null;
  }
  process.stderr.write = origWrite;
  process.stdout.write(`${JSON.stringify({ proxy, stderr })}\n`);
}

void main();
