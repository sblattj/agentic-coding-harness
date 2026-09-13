// Dashboard-server runner for tests/web.test.ts, web-trio.test.ts and
// web-pty.test.ts.
//
// The server is node:http based (runtime-agnostic), but the tests spawn
// this file as a bun subprocess so the PTY relay (bun-pty) also works
// where the scenario needs it. argv: [stateDir, token] — an empty token
// argument means "no token".
import { startWebServer } from '../../src/web/server.ts';

const [stateDir = '', token = ''] = process.argv.slice(2);
const handle = await startWebServer({
  port: 0, // ephemeral: the real port is reported on the READY line
  host: '127.0.0.1',
  token: token === '' ? undefined : token,
  stateDir,
});
process.stdout.write(`READY ${handle.port}\n`);

const shutdown = (): void => {
  void handle.close().then(
    () => process.exit(0),
    () => process.exit(1),
  );
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
