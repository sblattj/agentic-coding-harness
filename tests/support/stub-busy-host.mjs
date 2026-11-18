// Stub desk host for the startHost race test. Launched as `<node> <this file> desk host --spec <file>`
// (via ACH_SELF_ARGV). /health reports "starting" for ~300 ms and then "busy" forever, never "idle",
// like a lane whose goal turn begins right after the host comes up. POST /stop exits.
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

const specFile = process.argv[process.argv.indexOf('--spec') + 1];
const spec = JSON.parse(readFileSync(specFile, 'utf8'));
const t0 = Date.now();
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
      state: Date.now() - t0 < 300 ? 'starting' : 'busy',
      queueDepth: 0,
      lastSeq: 0,
    });
    return;
  }
  send({});
});
server.listen(spec.port, '127.0.0.1');
