// The kiro MITM tap must only intercept the Kiro/AWS endpoints it meters.
// kiro-cli hands its env (HTTPS_PROXY, SSL_CERT_FILE, NODE_EXTRA_CA_CERTS) to
// every shell tool the agent runs, so any other HTTPS client in the agent's
// shell also goes through mitmdump. Unscoped, mitmdump re-terminates TLS for
// every host, and a host whose chain mitmdump cannot verify comes back as 502.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import {
  KIRO_TAP_HOSTS_ENV,
  mitmdumpAvailable,
  mitmdumpArgs,
  removeTapCaBundle,
  startKiroMitm,
  tapCaBundlePath,
  tapAllowHostsRegex,
  tapEnv,
} from '../src/monitors/kiro-mitm.js';

const KIRO_HOSTS = [
  'codewhisperer.us-east-1.amazonaws.com:443',
  'codewhisperer.eu-central-1.amazonaws.com:443',
  'runtime.us-east-1.kiro.dev:443',
  'CodeWhisperer.us-east-1.amazonaws.com:443',
];
const OTHER_HOSTS = [
  'api.anthropic.com:443',
  'registry.npmjs.org:443',
  'github.com:443',
  '160.79.104.10:443',
  'codewhisperer.us-east-1.amazonaws.com.example.net:443',
  'evil-codewhisperer.us-east-1.amazonaws.com:443',
  'runtime.us-east-1.kiro.dev.example.net:443',
];

function allowHostsFromArgs(args: string[]): string {
  const i = args.indexOf('--allow-hosts');
  assert.ok(i >= 0, `mitmdump args lack --allow-hosts: ${JSON.stringify(args)}`);
  const rx = args[i + 1];
  assert.ok(rx, '--allow-hosts has no value');
  return rx;
}

describe('kiro tap host scope', () => {
  it('mitmdump args restrict interception to the metered Kiro hosts', () => {
    const args = mitmdumpArgs(0, '/tmp/addon.py', {});
    assert.deepEqual(args.slice(0, 4), ['-p', '0', '--listen-host', '127.0.0.1']);
    assert.ok(args.includes('-s') && args[args.indexOf('-s') + 1] === '/tmp/addon.py');
    // mitmproxy matches allow_hosts with re.search(..., IGNORECASE) over "host:port".
    const rx = new RegExp(allowHostsFromArgs(args), 'i');
    for (const h of KIRO_HOSTS) assert.ok(rx.test(h), `should intercept ${h}`);
    for (const h of OTHER_HOSTS) assert.ok(!rx.test(h), `should NOT intercept ${h}`);
  });

  it(`${KIRO_TAP_HOSTS_ENV} extends the allow list`, () => {
    const env = { [KIRO_TAP_HOSTS_ENV]: String.raw`q\.[^:/]*\.amazonaws\.com, ` + String.raw`api\.example\.dev` };
    const rx = new RegExp(tapAllowHostsRegex(env), 'i');
    assert.ok(rx.test('q.us-east-1.amazonaws.com:443'));
    assert.ok(rx.test('api.example.dev:443'));
    assert.ok(rx.test('runtime.us-east-1.kiro.dev:443'), 'defaults kept');
    assert.ok(!rx.test('api.anthropic.com:443'));
    assert.deepEqual(new RegExp(allowHostsFromArgs(mitmdumpArgs(0, 'a.py', env)), 'i').source, rx.source);
  });

  it('allow-hosts regex compiles and matches the same way under Python re', (t) => {
    const py = spawnSync('python3', ['--version']);
    if (py.error || py.status !== 0) return t.skip('python3 not available');
    const rx = tapAllowHostsRegex({});
    const script =
      'import re,sys,json\n' +
      'rx=re.compile(sys.argv[1], re.IGNORECASE)\n' +
      'print(json.dumps([bool(rx.search(h)) for h in sys.argv[2:]]))\n';
    const r = spawnSync('python3', ['-c', script, rx, ...KIRO_HOSTS, ...OTHER_HOSTS], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), [...KIRO_HOSTS.map(() => true), ...OTHER_HOSTS.map(() => false)]);
  });

  it('tapEnv SSL_CERT_FILE trusts the tap CA AND the public roots (tunneled hosts keep verifying)', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kiro-tap-ca-'));
    try {
      const fakeCa = '-----BEGIN CERTIFICATE-----\nTAPCAFAKE\n-----END CERTIFICATE-----\n';
      const caPath = path.join(dir, 'ca.pem');
      writeFileSync(caPath, fakeCa);
      const env = tapEnv(1234, caPath);
      assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1234');
      assert.equal(env.NODE_EXTRA_CA_CERTS, caPath, 'NODE_EXTRA_CA_CERTS is additive; keep the bare CA');
      assert.ok(env.SSL_CERT_FILE && env.SSL_CERT_FILE !== caPath, 'SSL_CERT_FILE must not be the bare tap CA');
      const bundle = readFileSync(env.SSL_CERT_FILE, 'utf8');
      assert.ok(bundle.includes('TAPCAFAKE'), 'bundle lacks the tap CA');
      const certs = bundle.match(/-----BEGIN CERTIFICATE-----/g) ?? [];
      assert.ok(certs.length > 10, `bundle has only ${certs.length} certs; public roots missing`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('tapEnv falls back to the bare CA path when the CA file does not exist', () => {
    const env = tapEnv(1234, '/nonexistent/ca.pem');
    assert.equal(env.SSL_CERT_FILE, '/nonexistent/ca.pem');
  });
});

// Live: a non-Kiro host through the tap must be tunneled raw (the client sees
// the origin's own certificate, not one minted by the mitmproxy CA).
const CA = path.join(os.homedir(), '.mitmproxy', 'mitmproxy-ca-cert.pem');
const canLive = mitmdumpAvailable() && existsSync(CA) && !process.env.ACH_TEST_OFFLINE;

function issuerViaProxy(proxyPort: number, host: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1');
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('timeout'));
    }, 15000);
    let buf = '';
    sock.once('connect', () => sock.write(`CONNECT ${host}:443 HTTP/1.1\r\nHost: ${host}:443\r\n\r\n`));
    const onData = (d: Buffer): void => {
      buf += d.toString('latin1');
      if (!buf.includes('\r\n\r\n')) return;
      sock.off('data', onData);
      if (!/^HTTP\/1\.[01] 200/.test(buf)) {
        clearTimeout(timer);
        sock.destroy();
        return reject(new Error(`CONNECT failed: ${buf.split('\r\n')[0]}`));
      }
      const t = tls.connect({ socket: sock, servername: host, rejectUnauthorized: false }, () => {
        const issuer = t.getPeerCertificate().issuer;
        clearTimeout(timer);
        t.destroy();
        resolve(`${issuer?.O ?? ''} ${issuer?.CN ?? ''}`);
      });
      t.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
    };
    sock.on('data', onData);
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

describe('kiro tap host scope (live mitmdump)', { skip: !canLive && 'mitmdump or its CA not available' }, () => {
  it('non-Kiro hosts are tunneled raw; Kiro hosts are intercepted', async (t) => {
    const mitm = startKiroMitm(0);
    try {
      const port = await mitm.ready;
      let other: string;
      try {
        other = await issuerViaProxy(port, 'registry.npmjs.org');
      } catch (err) {
        return t.skip(`no network: ${(err as Error).message}`);
      }
      assert.doesNotMatch(other, /mitmproxy/i, `registry.npmjs.org was intercepted (issuer: ${other})`);
      const kiro = await issuerViaProxy(port, 'codewhisperer.us-east-1.amazonaws.com');
      assert.match(kiro, /mitmproxy/i, `Kiro host was not intercepted (issuer: ${kiro})`);
    } finally {
      await mitm.stop();
      rmSync(mitm.scriptPath, { force: true });
    }
  });
});

describe('kiro tap CA bundle cleanup', () => {
  it('stop() removes the tap CA bundle tapEnv wrote; a missing bundle is fine', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kiro-tap-stop-'));
    try {
      const caPath = path.join(dir, 'ca.pem');
      writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nTAPCAFAKE\n-----END CERTIFICATE-----\n');
      // Fake mitmdump: print the listening banner, then wait for SIGTERM.
      const fake = path.join(dir, 'mitmdump');
      writeFileSync(fake, '#!/bin/sh\necho "HTTP(S) proxy listening at 127.0.0.1:45991."\nexec sleep 30\n', {
        mode: 0o755,
      });
      const mitm = startKiroMitm(0, { mitmdumpBin: fake, scriptPath: path.join(dir, 'addon.py') });
      const port = await mitm.ready;
      assert.equal(port, 45991);
      const bundle = tapEnv(port, caPath).SSL_CERT_FILE as string;
      assert.equal(bundle, tapCaBundlePath(port));
      assert.ok(existsSync(bundle), 'bundle not written');
      await mitm.stop();
      assert.ok(!existsSync(bundle), 'bundle survived tap stop');
      await mitm.stop(); // second stop: bundle already gone, must not throw
      removeTapCaBundle(port); // ENOENT ignored
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
