// site/test/local-runner.mjs — accelerate.sh and site/serve-local.mjs, each promise fed its red case. No browser.
//
//   node site/test/local-runner.mjs        (run after committing: the script tests clone this repo's HEAD)
//
// Everything runs in a temp folder with HOME pointed into it, so nothing lands in the real home folder, and the
// "remote" is a bare clone of this repo's HEAD in that folder (ACCEL_REPO_URL), so the clone and update paths run
// without the network. One test forwards a real getblockcount to SUBFROST through the server.
//
// server:  serves exactly the files in local/build.json (index, app, wasm, build.json) and nothing else; refuses
//          a foreign Host (421), a foreign Origin (403), a body over 1 MB (413), other paths and methods (404);
//          forwards JSON-RPC; moves to the next port when the first is taken; refuses to start when a file is
//          edited, missing, or the build manifest is absent.
// script:  no Node → says how to install it; a folder that is not this repo → refused, untouched; first run clones
//          and starts; second run reuses ("Up to date"); a new commit upstream → fast-forwarded ("Updated a → b");
//          local changes → not updated, still starts; run from inside a clone → uses that clone.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accel-runner-'));
const home = path.join(tmp, 'home');
fs.mkdirSync(home);
const results = [];
const record = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const git = (cwd, ...a) => execFileSync('git', ['-C', cwd, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

// Start a process; resolve when its output matches `ready` (or it exits). Returns { child, out, code }.
function start(cmd, args, { env = {}, ready = /running at http:\/\/localhost:(\d+)\/[\s\S]*files verified/, timeout = 60_000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { env: { ...process.env, HOME: home, ACCEL_NO_OPEN: '1', ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let done = false;
    const finish = (code) => { if (!done) { done = true; clearTimeout(t); resolve({ child, out, code, port: Number(out.match(ready)?.[1]) || null }); } };
    const t = setTimeout(() => finish('timeout'), timeout);
    const onData = (d) => { out += d; if (ready.test(out)) finish(null); };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => finish(code));
  });
}
const stop = (r) => { try { process.kill(-r.child.pid, 'SIGTERM'); } catch {} };
function req(port, { method = 'GET', path: p = '/', headers = {}, body } = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: { host: `localhost:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }));
    });
    r.on('error', (e) => resolve({ status: 0, body: Buffer.from(String(e)) }));
    if (body) r.write(body);
    r.end();
  });
}
const rpc = JSON.stringify({ jsonrpc: '2.0', method: 'getblockcount', params: [], id: 1 });
const jsonHdr = { 'content-type': 'application/json' };

try {
  // ── server ──
  const p0 = await freePort();
  const s = await start('node', [path.join(repo, 'site/serve-local.mjs'), '--port', String(p0), '--no-open']);
  record('server starts and verifies its files', s.port === p0 && /3 files verified/.test(s.out), s.out.split('\n').filter(Boolean)[1]?.trim());
  const idx = await req(p0);
  record('GET / is local/index.html, byte for byte', idx.status === 200 && idx.body.equals(fs.readFileSync(path.join(repo, 'local/index.html'))));
  const wasm = await req(p0, { path: '/subfrost_wallet_core_wasm_bg.wasm' });
  record('the wasm is served', wasm.status === 200 && wasm.body.length > 1e6);
  const unlisted = await Promise.all(['/../site/serve-local.mjs', '/%2e%2e/accelerate.sh', '/local/app.js', '/accelerate.sh', '/.git/config'].map((p) => req(p0, { path: p })));
  record('paths outside the build are not served', unlisted.every((r) => r.status === 404), unlisted.map((r) => r.status).join(','));
  record('a foreign Host is refused (DNS rebinding)', (await req(p0, { headers: { host: `evil.example:${p0}` } })).status === 421);
  const foreign = await req(p0, { method: 'POST', path: '/api/rpc/mainnet', headers: { ...jsonHdr, origin: 'https://evil.example' }, body: rpc });
  record('a POST from another site is refused', foreign.status === 403);
  const big = await req(p0, { method: 'POST', path: '/api/rpc/mainnet', headers: jsonHdr, body: Buffer.alloc((1 << 20) + 10, 0x20) });
  record('a body over 1 MB is refused', big.status === 413);
  const other = await Promise.all([req(p0, { method: 'PUT' }), req(p0, { method: 'POST', path: '/api/rpc/signet', headers: jsonHdr, body: rpc }), req(p0, { method: 'POST', path: '/api/rpc/mainnet/espo', headers: jsonHdr, body: rpc })]);
  record('other methods and RPC paths are refused', other.every((r) => r.status === 404), other.map((r) => r.status).join(','));
  const fwd = await req(p0, { method: 'POST', path: '/api/rpc/mainnet', headers: { ...jsonHdr, origin: `http://localhost:${p0}` }, body: rpc });
  const height = fwd.status === 200 ? JSON.parse(fwd.body).result : null;
  record('JSON-RPC from the page is forwarded to SUBFROST', Number.isInteger(height) && height > 970_000, `getblockcount ${height}`);

  const taken = await start('node', [path.join(repo, 'site/serve-local.mjs'), '--port', String(p0), '--no-open']);
  record('a taken port moves to the next one', taken.port === p0 + 1, `got ${taken.port}`);
  stop(taken);
  stop(s);

  // Integrity red cases on a copy: edited, missing, no manifest, and an unlisted file.
  const copy = (name) => {
    const d = path.join(tmp, name);
    fs.mkdirSync(path.join(d, 'site'), { recursive: true });
    fs.copyFileSync(path.join(repo, 'site/serve-local.mjs'), path.join(d, 'site/serve-local.mjs'));
    fs.cpSync(path.join(repo, 'local'), path.join(d, 'local'), { recursive: true });
    return d;
  };
  const edited = copy('edited');
  const appJs = path.join(edited, 'local/app.js');
  const bytes = fs.readFileSync(appJs);
  bytes[bytes.length >> 1] ^= 1;
  fs.writeFileSync(appJs, bytes);
  const e1 = await start('node', [path.join(edited, 'site/serve-local.mjs'), '--port', String(await freePort())]);
  record('one flipped bit → refuses to start', e1.code === 1 && /app\.js does not match the build/.test(e1.out), e1.out.trim().split('\n')[0]);
  const missing = copy('missing');
  fs.rmSync(path.join(missing, 'local/subfrost_wallet_core_wasm_bg.wasm'));
  const e2 = await start('node', [path.join(missing, 'site/serve-local.mjs'), '--port', String(await freePort())]);
  record('a missing file → refuses to start', e2.code === 1 && /is missing/.test(e2.out));
  const nomani = copy('nomani');
  fs.rmSync(path.join(nomani, 'local/build.json'));
  const e3 = await start('node', [path.join(nomani, 'site/serve-local.mjs'), '--port', String(await freePort())]);
  record('no manifest → refuses to start', e3.code === 1 && /No build found/.test(e3.out));
  const extra = copy('extra');
  fs.writeFileSync(path.join(extra, 'local/extra.js'), 'alert(1)');
  const pe = await freePort();
  const e4 = await start('node', [path.join(extra, 'site/serve-local.mjs'), '--port', String(pe), '--no-open']);
  record('a file not in the manifest is never served', (await req(pe, { path: '/extra.js' })).status === 404);
  stop(e4);

  // ── accelerate.sh ──
  const src = path.join(tmp, 'remote.git');
  execFileSync('git', ['clone', '--quiet', '--bare', repo, src]);
  const dl = path.join(tmp, 'dl');
  fs.mkdirSync(dl);
  const script = path.join(dl, 'accelerate.sh');
  fs.copyFileSync(path.join(repo, 'accelerate.sh'), script);
  const env = { ACCEL_REPO_URL: src };
  const clone = path.join(home, 'alkanes-safe-accelerate');

  const noNode = await start('/bin/bash', [script], { env: { ...env, PATH: '/usr/bin:/bin' } });
  record('no Node → says how to install it', noNode.code === 1 && /Node\.js is not installed/.test(noNode.out) && !fs.existsSync(clone));

  const notRepo = path.join(tmp, 'not-repo');
  fs.mkdirSync(notRepo);
  fs.writeFileSync(path.join(notRepo, 'keep.txt'), 'mine');
  const nr = await start('/bin/bash', [script], { env: { ...env, ACCEL_DIR: notRepo } });
  record('a folder that is not this repo → refused, untouched', nr.code === 1 && /is not a copy of/.test(nr.out) && fs.readdirSync(notRepo).join() === 'keep.txt');

  const first = await start('/bin/bash', [script, '--port', String(await freePort())], { env });
  const firstIdx = first.port ? await req(first.port) : { status: 0 };
  record('first run: clones to ~/alkanes-safe-accelerate and starts', /Downloading the accelerator/.test(first.out) && fs.existsSync(path.join(clone, '.git')) && firstIdx.status === 200, first.out.trim().split('\n')[0]);
  stop(first);

  const second = await start('/bin/bash', [script, '--port', String(await freePort())], { env });
  record('second run: reuses the copy, no download', /Up to date/.test(second.out) && !/Downloading/.test(second.out) && second.port !== null);
  stop(second);

  // A new commit upstream → fast-forwarded on the next run.
  const pusher = path.join(tmp, 'pusher');
  execFileSync('git', ['clone', '--quiet', src, pusher]);
  fs.writeFileSync(path.join(pusher, 'upstream-change.txt'), 'new');
  git(pusher, 'add', 'upstream-change.txt');
  git(pusher, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'upstream change');
  git(pusher, 'push', '--quiet', 'origin', 'HEAD:main');
  const third = await start('/bin/bash', [script, '--port', String(await freePort())], { env });
  record('a new upstream commit is fast-forwarded', /Updated [0-9a-f]+ → [0-9a-f]+/.test(third.out) && fs.existsSync(path.join(clone, 'upstream-change.txt')) && third.port !== null, third.out.trim().split('\n')[0]);
  stop(third);

  fs.writeFileSync(path.join(clone, 'my-note.txt'), 'local');
  const dirty = await start('/bin/bash', [script, '--port', String(await freePort())], { env });
  record('local changes → not updated, still starts', /Not updating: .* has local changes/.test(dirty.out) && dirty.port !== null);
  stop(dirty);
  fs.rmSync(path.join(clone, 'my-note.txt'));

  // Run from inside the clone, with no ACCEL_DIR and HOME elsewhere: it must use itself.
  const otherHome = path.join(tmp, 'home2');
  fs.mkdirSync(otherHome);
  const inside = await start('/bin/bash', [path.join(clone, 'accelerate.sh'), '--no-update', '--port', String(await freePort())], { env: { ...env, HOME: otherHome } });
  record('run from inside a clone → uses that clone', inside.port !== null && !fs.existsSync(path.join(otherHome, 'alkanes-safe-accelerate')));
  stop(inside);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
