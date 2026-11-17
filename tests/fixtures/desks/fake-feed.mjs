// Scripted JSONL feed for desks-feeds tests. argv[2] = JSON array of steps:
//   {delay: ms}  wait | {line: obj} print JSON line | {raw: "text"} print verbatim line
//   {stderr: "text"} | {exit: n} exit | {hold: true} stay alive forever (at end)
// argv[3] (optional) = path; the pid is appended there on start.
import { appendFileSync } from "node:fs";

const steps = JSON.parse(process.argv[2] ?? "[]");
if (process.argv[3]) appendFileSync(process.argv[3], `${process.pid}\n`);
process.on("SIGTERM", () => process.exit(143));
for (const s of steps) {
  if (s.delay) await new Promise((r) => setTimeout(r, s.delay));
  if (s.line) process.stdout.write(`${JSON.stringify(s.line)}\n`);
  if (s.raw !== undefined) process.stdout.write(`${s.raw}\n`);
  if (s.stderr !== undefined) process.stderr.write(`${s.stderr}\n`);
  if (s.exit !== undefined) process.exit(s.exit);
}
setInterval(() => {}, 1 << 30);
