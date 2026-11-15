// Fake Claude Code TUI for the interactive-run tests (#195).
//
// Behaves like `claude "<prompt>" --session-id <id> --model <m> ...` in a PTY:
// prints a banner, then for every prompt (the first from argv, the rest typed
// and submitted with Enter) appends a user line, an assistant line with usage
// and a turn_duration marker to $HOME/.claude/projects/-fake-project/<id>.jsonl.
// `/exit` quits 0. SIGINT writes $FAKE_TUI_MARKER (when set) and exits 130,
// unless FAKE_TUI_IGNORE_SIGINT=1.
//
// Usage per turn: FAKE_TUI_USAGE='{"input_tokens":..}' (JSON), default small.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const argv = process.argv.slice(2);
const sessionId = argv[argv.indexOf("--session-id") + 1] ?? "no-session";
const model = argv.includes("--model") ? argv[argv.indexOf("--model") + 1]! : "claude-sonnet-4-5";
const firstPrompt = argv[0] !== undefined && !argv[0].startsWith("--") ? argv[0] : "";
const dir = path.join(os.homedir(), ".claude", "projects", "-fake-project");
mkdirSync(dir, { recursive: true });
const file = path.join(dir, `${sessionId}.jsonl`);
writeFileSync(file, "");
writeFileSync(path.join(os.homedir(), "fake-tui-argv.json"), JSON.stringify(argv));
const usage = process.env.FAKE_TUI_USAGE ? JSON.parse(process.env.FAKE_TUI_USAGE) : { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 };

let turn = 0;
function line(obj: Record<string, unknown>): void {
  appendFileSync(file, JSON.stringify({ sessionId, cwd: process.cwd(), timestamp: new Date().toISOString(), ...obj }) + "\n");
}
function answer(prompt: string): void {
  turn++;
  line({ type: "user", message: { role: "user", content: prompt } });
  const id = `msg_fake_${turn}`;
  // Two blocks of one response share the id; the earlier carries partial usage
  // (as Claude Code writes them), and only the last one may count.
  line({ type: "assistant", requestId: `req_${turn}`, message: { id, model, role: "assistant", content: [{ type: "text", text: `echo: ${prompt}` }], usage: { ...usage, output_tokens: 1 } } });
  line({ type: "assistant", requestId: `req_${turn}`, message: { id, model, role: "assistant", content: [{ type: "tool_use", id: `tu_${turn}`, name: "Bash", input: { command: "true" } }], usage } });
  line({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${turn}`, content: "ok" }] } });
  line({ type: "system", subtype: "turn_duration", durationMs: 5 });
  process.stdout.write(`\r\n⏺ echo: ${prompt}\r\n❯ `);
}

process.on("SIGINT", () => {
  if (process.env.FAKE_TUI_MARKER) writeFileSync(process.env.FAKE_TUI_MARKER, "SIGINT\n");
  if (process.env.FAKE_TUI_IGNORE_SIGINT === "1") return;
  process.exit(130);
});
process.on("SIGTERM", () => {
  if (process.env.FAKE_TUI_MARKER) appendFileSync(process.env.FAKE_TUI_MARKER, "SIGTERM\n");
  if (process.env.FAKE_TUI_IGNORE_SIGINT === "1") return;
  process.exit(143);
});

process.stdout.write(`FAKE CLAUDE TUI session ${sessionId} model ${model}\r\n❯ `);
if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
let buf = "";
process.stdin.on("data", (chunk: string) => {
  for (const ch of chunk) {
    if (ch === "\r" || ch === "\n") {
      const prompt = buf;
      buf = "";
      if (prompt === "/exit") {
        process.stdout.write("\r\nbye\r\n");
        setTimeout(() => process.exit(0), 50);
        return;
      }
      if (prompt !== "") answer(prompt);
    } else if (ch === "\x03") {
      process.emit("SIGINT");
    } else {
      buf += ch;
      process.stdout.write(ch);
    }
  }
});
if (firstPrompt !== "") setTimeout(() => answer(firstPrompt), 200);
