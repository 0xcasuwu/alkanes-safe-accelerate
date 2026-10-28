// site/build.mjs — builds both deliverables from a clean subfrost-app checkout:
//
//   docs/    GitHub Pages (main:/docs): the setup guide (index.html, from src/setup.html) with accelerate.sh to read
//            or download, and the read-only Accelerate Check in docs/check/.
//   local/   the accelerator itself, prebuilt and committed, so accelerate.sh runs it with Node alone
//            (site/serve-local.mjs serves it; it signs with a keystore held in the tab's memory).
//
//   node site/build.mjs [path-to-subfrost-app-checkout]     (default ~/Documents/wt-accel-app)
//
// Both pages bundle subfrost-app's OWN lib/accelerate (and the accelerator also its signing and checking modules)
// plus its vendored wallet-core wasm, so they run the code the app runs. The checkout must be clean. Its HEAD,
// the core pin and the wasm sha256 (the app's PIN.json) are stamped into every page and into the build.json files,
// so anyone can tell which code a copy runs.
//
// SAFETY CHECKS
//   - The read-only checker's bundle must not contain a wallet signing / sending method or a broadcast endpoint;
//     if any of those names appears, the build fails.
//   - local/build.json records the sha256 of every file in local/. serve-local.mjs refuses to start if one
//     differs, and serves nothing that is not listed.
//   - Every host named in the accelerator bundle is listed in local/build.json for review. The browser enforces
//     the page's CSP (itself, mempool.space, ordinals.com); site/test/poc-smoke.mjs asserts every request the
//     page makes goes to one of those.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '..');
const app = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'Documents/wt-accel-app'));
const docs = path.join(repo, 'docs');
const local = path.join(repo, 'local');
const git = (...a) => execFileSync('git', ['-C', app, ...a], { encoding: 'utf8' }).trim();
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

if (git('status', '--porcelain')) throw new Error(`${app} has uncommitted changes: build from a committed state`);
const appCommit = git('rev-parse', 'HEAD');
const pin = JSON.parse(fs.readFileSync(path.join(app, 'vendor/subfrost-wallet-core/PIN.json'), 'utf8'));
const wasmSrc = path.join(app, 'vendor/subfrost-wallet-core/subfrost_wallet_core_wasm_bg.wasm');
const wasmSha = sha256(wasmSrc);
if (wasmSha !== pin.wasmSha256) throw new Error(`vendored wasm ${wasmSha} != PIN ${pin.wasmSha256}`);
const builtAt = new Date().toISOString().slice(0, 10);

const require = createRequire(path.join(app, 'package.json'));
const esbuild = require(path.join(app, 'node_modules/.pnpm/node_modules/esbuild'));
const bundle = (entry, outfile) => esbuild.build({
  entryPoints: [path.join(here, entry)],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: false,
  outfile,
  alias: { '@': app },
  nodePaths: [path.join(app, 'node_modules')],
  define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}', global: 'globalThis' },
  logLevel: 'warning',
  metafile: true,
});
const stamp = (src, extra = {}) => {
  let html = fs.readFileSync(path.join(here, src), 'utf8')
    .replaceAll('{{APP_COMMIT}}', appCommit.slice(0, 12))
    .replaceAll('{{CORE_COMMIT}}', pin.commit.slice(0, 12))
    .replaceAll('{{WASM_SHA}}', wasmSha.slice(0, 16))
    .replaceAll('{{BUILT_AT}}', builtAt);
  for (const [k, v] of Object.entries(extra)) html = html.replaceAll(`{{${k}}}`, v);
  if (/\{\{[A-Z_]+\}\}/.test(html)) throw new Error(`unfilled placeholder in ${src}`);
  return html;
};

for (const d of [docs, local]) fs.rmSync(d, { recursive: true, force: true });
const check = path.join(docs, 'check');
fs.mkdirSync(check, { recursive: true });
fs.mkdirSync(local, { recursive: true });

// ── docs/check/: the read-only checker ──
const checkResult = await bundle('src/main.ts', path.join(check, 'app.js'));
const js = fs.readFileSync(path.join(check, 'app.js'), 'utf8');
const FORBIDDEN = ['signPsbt', 'signPsbts', 'signTaprootPsbt', 'signMessage', 'sendBitcoin', 'sendTransfer', 'pushPsbt', 'pushTx', 'esplora_tx::broadcast', 'sendrawtransaction', 'submitpackage', '/api/tx"'];
const hits = FORBIDDEN.filter((f) => js.includes(f));
if (hits.length) {
  // Which inputs carried them, so the import can be cut rather than the check weakened.
  const carriers = Object.keys(checkResult.metafile.inputs).filter((f) => {
    try { return hits.some((h) => fs.readFileSync(f.startsWith('/') ? f : path.join(repo, f), 'utf8').includes(h)); } catch { return false; }
  });
  throw new Error(`checker bundle contains ${hits.join(', ')} (from ${carriers.join(', ')})`);
}
fs.copyFileSync(wasmSrc, path.join(check, 'subfrost_wallet_core_wasm_bg.wasm'));
fs.writeFileSync(path.join(check, 'index.html'), stamp('src/index.html', {
  ENGINE_TESTS: process.env.ENGINE_TESTS ?? '49',
  MUTANTS: process.env.MUTANTS ?? '37',
}));

// ── local/: the accelerator, run by accelerate.sh ──
await bundle('src/accelerate.ts', path.join(local, 'app.js'));
fs.copyFileSync(wasmSrc, path.join(local, 'subfrost_wallet_core_wasm_bg.wasm'));
fs.writeFileSync(path.join(local, 'index.html'), stamp('src/accelerate.html'));
const pocJs = fs.readFileSync(path.join(local, 'app.js'), 'utf8');
const pocHosts = [...new Set([...pocJs.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()))].sort();
const localFiles = Object.fromEntries(['index.html', 'app.js', 'subfrost_wallet_core_wasm_bg.wasm'].map((f) => [f, sha256(path.join(local, f))]));
fs.writeFileSync(path.join(local, 'build.json'), JSON.stringify({ appCommit, coreCommit: pin.commit, wasmSha256: wasmSha, builtAt, files: localFiles, hostsNamedInBundle: pocHosts }, null, 2) + '\n');

// ── docs/: the setup guide ──
fs.copyFileSync(path.join(repo, 'accelerate.sh'), path.join(docs, 'accelerate.sh'));
fs.copyFileSync(path.join(here, 'src/setup.js'), path.join(docs, 'setup.js'));
fs.writeFileSync(path.join(docs, 'index.html'), stamp('src/setup.html'));
fs.writeFileSync(path.join(docs, '.nojekyll'), '');
fs.writeFileSync(path.join(docs, 'build.json'), JSON.stringify({ appCommit, coreCommit: pin.commit, wasmSha256: wasmSha, builtAt, accelerateSh: sha256(path.join(repo, 'accelerate.sh')) }, null, 2) + '\n');

const kb = (f) => `${(fs.statSync(f).size / 1024).toFixed(0)} KB`;
console.log(`built from ${appCommit.slice(0, 12)}: docs/check/app.js ${kb(path.join(check, 'app.js'))}, local/app.js ${kb(path.join(local, 'app.js'))}, wasm ${kb(wasmSrc)}`);
console.log(`hosts named in the accelerator bundle: ${pocHosts.join(', ')}`);
