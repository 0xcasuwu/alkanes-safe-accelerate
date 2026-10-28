// site/serve-local.mjs — runs the accelerator on THIS computer. accelerate.sh starts it; nothing to install.
//
//   node site/serve-local.mjs [--port 4173] [--no-open]      (ACCEL_NO_OPEN=1 also skips opening the browser)
//
// WHY A LOCAL SERVER (measured 2026-10-28): the page runs in the browser, and a browser may read SUBFROST's API
// only from a site the API key allows. /v4/subfrost answers 403 CORS_BLOCKED for 0xcasuwu.github.io and for
// localhost, but 200 to a program, which sends no Origin. So this serves the prebuilt page (local/) and forwards
// the page's JSON-RPC calls to the gateway itself. That is what subfrost-app's /api/rpc route does for JSON-RPC on
// mainnet: single and batch requests both go to https://mainnet.subfrost.io/v4/subfrost
// (app/api/rpc/[[...segments]]/route.ts pickEndpoint). The page's other reads go straight to mempool.space and
// ordinals.com, which allow any site.
//
// WHAT PASSES THROUGH: JSON-RPC calls only. Those are reads, plus testmempoolaccept and the broadcast of the SIGNED
// transaction (lib/alkanes/rpc.ts sendRawTransaction). The recovery phrase stays in the page and never reaches
// this process.
//
// WHAT IT REFUSES, so nothing else on the machine or the network can use it:
//   - it listens on 127.0.0.1 only;
//   - Host must be localhost / 127.0.0.1 at this port (a DNS-rebinding page sends its own name)   → 421
//   - a POST whose Origin is another site open in the same browser                                → 403
//   - any path but the files in local/build.json and POST /api/rpc/mainnet                        → 404, logged
//   - a request body over 1 MB                                                                     → 413
// BEFORE LISTENING it hashes every file listed in local/build.json and refuses to start if one differs (a damaged
// or edited copy). Only those files are served, so no other path on disk is reachable.
// Tests: site/test/local-runner.mjs (each refusal above, fed its red case) and site/test/poc-smoke.mjs (the page).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../local');
const UPSTREAM = 'https://mainnet.subfrost.io/v4/subfrost';
const UPSTREAM_TIMEOUT_MS = 30_000;
const MAX_BODY = 1 << 20;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.wasm': 'application/wasm', '.json': 'application/json' };

const args = process.argv.slice(2);
const portArg = args.indexOf('--port');
const firstPort = portArg >= 0 ? Number(args[portArg + 1]) : 4173;
const openBrowser = !args.includes('--no-open') && process.env.ACCEL_NO_OPEN !== '1';
if (!Number.isInteger(firstPort) || firstPort < 1 || firstPort > 65535) fail(`--port must be a port number, got ${args[portArg + 1]}`);

function fail(msg) {
  console.error(`\n  ✗ ${msg}\n`);
  process.exit(1);
}

// ── integrity: every file the page needs, exactly as built ──
let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(path.join(root, 'build.json'), 'utf8'));
} catch {
  fail(`No build found in ${root}. The download looks incomplete: delete that folder and run accelerate.sh again.`);
}
const files = new Map();
for (const [name, sha] of Object.entries(manifest.files ?? {})) {
  let bytes;
  try { bytes = fs.readFileSync(path.join(root, name)); } catch { fail(`${name} is missing from ${root}. Delete that folder and run accelerate.sh again.`); }
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== sha) fail(`${name} does not match the build (sha256 ${got.slice(0, 12)}…, expected ${sha.slice(0, 12)}…). This copy was damaged or edited. Restore it with: git -C "${path.dirname(root)}" checkout -- local`);
  files.set(`/${name}`, { bytes, type: TYPES[path.extname(name)] ?? 'application/octet-stream' });
}
if (!files.has('/index.html')) fail('The build has no index.html.');
files.set('/build.json', { bytes: Buffer.from(JSON.stringify(manifest, null, 2)), type: TYPES['.json'] });

const jsonRpcError = (res, status, message) => {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
};

// The request body, or null past MAX_BODY. The rest is still read and discarded (not a reset), so the client
// gets the 413 instead of a broken connection.
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      if (size > MAX_BODY) return;
      size += c.length;
      if (size > MAX_BODY) { chunks.length = 0; resolve(null); } else chunks.push(c);
    });
    req.on('end', () => { if (size <= MAX_BODY) resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

function handler(port) {
  const hosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const origins = new Set([...hosts].map((h) => `http://${h}`));
  return async (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (!hosts.has(req.headers.host ?? '')) {
      console.log(`  refused: Host ${req.headers.host} (only localhost:${port} is served)`);
      res.writeHead(421); res.end('wrong host'); return;
    }
    if (req.method === 'POST' && url === '/api/rpc/mainnet') {
      const origin = req.headers.origin;
      if (origin !== undefined && !origins.has(origin)) {
        console.log(`  refused: a page on ${origin} tried to use this server`);
        jsonRpcError(res, 403, 'origin not allowed'); return;
      }
      const body = await readBody(req);
      if (body === null) { jsonRpcError(res, 413, 'request too large'); return; }
      try {
        const r = await fetch(UPSTREAM, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        });
        const answer = Buffer.from(await r.arrayBuffer());
        if (!r.ok) console.log(`  SUBFROST answered ${r.status}`);
        res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(answer);
      } catch (e) {
        console.log(`  could not reach SUBFROST: ${e?.message ?? e}`);
        jsonRpcError(res, 502, `could not reach SUBFROST: ${e?.message ?? e}`);
      }
      return;
    }
    const file = (req.method === 'GET' || req.method === 'HEAD') && files.get(url === '/' ? '/index.html' : url);
    if (!file) {
      if (url !== '/favicon.ico') console.log(`  not served: ${req.method} ${url}`);
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'content-type': file.type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : file.bytes);
  };
}

// ── listen on the first free port from firstPort ──
function listen(port, triesLeft) {
  const server = http.createServer(handler(port));
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && triesLeft > 0) listen(port + 1, triesLeft - 1);
    else fail(`Could not start on port ${port}: ${e.message}`);
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}/`;
    console.log(`\n  Accelerator running at ${url}`);
    console.log(`  Build: subfrost-app ${manifest.appCommit?.slice(0, 12)} · engine ${manifest.coreCommit?.slice(0, 12)} · built ${manifest.builtAt} · ${files.size - 1} files verified`);
    console.log('  Keep this window open while you use it. Press Ctrl+C to stop.\n');
    if (openBrowser) {
      const [cmd, cmdArgs] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
      try {
        const child = spawn(cmd, cmdArgs, { stdio: 'ignore', detached: true });
        child.on('error', () => console.log(`  Open ${url} in your browser.`));
        child.unref();
      } catch {
        console.log(`  Open ${url} in your browser.`);
      }
    }
  });
}
process.on('SIGINT', () => { console.log('\n  Stopped.'); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
listen(firstPort, 20);
