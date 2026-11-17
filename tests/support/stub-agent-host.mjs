// Stub desk host for the lifecycle tests. Launched as `<node> <this file> desk host --spec <file>`
// (via ACH_SELF_ARGV). Prints one "stub-host start" line per launch (stdout goes to the host log).
// When spec.agent equals $STUB_FAIL_AGENT it exits 1 at once, like a host whose engine cannot start;
// otherwise /health reports idle for the spec's runId and POST /stop exits.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const specFile = process.argv[process.argv.indexOf('--spec') + 1];
const spec = JSON.parse(readFileSync(specFile, 'utf8'));
process.stdout.write(`stub-host start agent=${spec.agent} port=${spec.port}\n`);
if (process.env.STUB_FAIL_AGENT && spec.agent === process.env.STUB_FAIL_AGENT) {
  process.stdout.write(`stub-host: agent ${spec.agent} refused\n`);
  process.exit(1);
}
const server = createServer((req, res) => {
  const send = (obj) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'POST' && req.url === '/stop') {
    send({ ok: true });
    setTimeout(() => process.exit(0), 20);
    return;
  }
  if (req.url === '/health') {
    send({
      version: 'desks-api/1',
      name: spec.name,
      kind: spec.kind,
      engine: spec.engine,
      agent: spec.agent,
      runId: spec.runId,
      pid: process.pid,
      state: 'idle',
      queueDepth: 0,
      lastSeq: 0,
    });
    return;
  }
  if (req.url === '/attach') {
    send({ argv: ['echo', spec.name] });
    return;
  }
  if (req.url?.startsWith('/events')) {
    send({ events: [] });
    return;
  }
  send({});
});
server.listen(spec.port, '127.0.0.1');
