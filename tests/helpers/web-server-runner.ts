// Dashboard-server runner for tests/web.test.ts.
//
// src/web/server.ts builds on Bun.serve, which does not exist under the
// tsx/node test runner (`npm test`); the test therefore spawns this file as a
// bun subprocess and talks to it over HTTP/WS. argv: [stateDir, token] —
// an empty token argument means "no token".
import { startWebServer } from '../../src/web/server.ts';

const [stateDir = '', token = ''] = process.argv.slice(2);
const handle = startWebServer({
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
