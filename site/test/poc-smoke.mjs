// site/test/poc-smoke.mjs — the accelerator (local/, served by site/serve-local.mjs) in Chromium, no human, no funds.
//
//   node site/test/poc-smoke.mjs [path-to-subfrost-app-checkout]      (starts its own server on a random port)
//   BASE_URL=http://localhost:4173/ node site/test/poc-smoke.mjs        (a server accelerate.sh already started)
//
// A THROWAWAY recovery phrase is generated here at run time (it holds nothing and is never reused):
//   - an invalid phrase is refused and the box is emptied;
//   - the throwaway unlocks; the page's taproot and native segwit addresses equal an independent BIP86 /
//     BIP84 derivation (m/86'/0'/0'/0/i, m/84'/0'/0'/0/i) — the app's coin-type rule on mainnet;
//   - the phrase box is empty afterwards and NO storage (local / session) holds any of its words;
//   - a live mempool transaction runs through the real pipeline (gateway reads, planning) and is refused
//     as not this wallet's;
//   - "Forget" locks the page again;
//   - every request the page makes goes to itself (the local server), mempool.space or ordinals.com.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const app = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'Documents/wt-accel-app'));
const require = createRequire(path.join(app, 'package.json'));
const { chromium } = require('@playwright/test');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
const bip39 = require('bip39');
const { BIP32Factory } = require('bip32');
bitcoin.initEccLib(ecc);
const bip32 = BIP32Factory(ecc);
const ALLOWED = new Set(['localhost', '127.0.0.1', 'mempool.space', 'ordinals.com']);

const results = [];
const record = (name, pass, detail) => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`); };

const phrase = bip39.generateMnemonic();
const seed = bip39.mnemonicToSeedSync(phrase);
const rootKey = bip32.fromSeed(seed, bitcoin.networks.bitcoin);
const trKey = rootKey.derivePath("m/86'/0'/0'/0/0");
const expectTr = bitcoin.payments.p2tr({ internalPubkey: Buffer.from(trKey.publicKey.slice(1, 33)) }).address;
const expectSw = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(rootKey.derivePath("m/84'/0'/0'/0/0").publicKey) }).address;

const port = 4300 + Math.floor(Math.random() * 500);
const server = process.env.BASE_URL ? null : spawn('node', [path.join(here, '../serve-local.mjs'), '--port', String(port), '--no-open'], { stdio: 'ignore' });
const base = process.env.BASE_URL ?? `http://localhost:${port}/`;
const browser = await chromium.launch();
try {
  await new Promise((r) => setTimeout(r, 900));
  const page = await browser.newPage();
  const hosts = new Set();
  const errors = [];
  page.on('request', (r) => hosts.add(new URL(r.url()).hostname));
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base);
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  record('CSP restricts connections', !!csp && /connect-src 'self' https:\/\/mempool\.space https:\/\/ordinals\.com;/.test(csp), csp?.slice(0, 120) ?? 'none');

  await page.fill('#seed', 'not a real phrase at all');
  await page.click('#unlock');
  await page.waitForFunction(() => document.getElementById('seed-error').textContent.length > 0, null, { timeout: 30_000 });
  record('invalid phrase refused, box emptied', /not a valid BIP39/.test(await page.textContent('#seed-error')) && (await page.inputValue('#seed')) === '', await page.textContent('#seed-error'));

  await page.fill('#seed', phrase);
  await page.click('#unlock');
  await page.waitForSelector('#unlocked:not([hidden])', { timeout: 60_000 });
  const shown = await page.textContent('#addresses');
  record('unlocked: addresses match BIP86/BIP84', shown.includes(expectTr) && shown.includes(expectSw), `taproot ${expectTr.slice(0, 14)}… segwit ${expectSw.slice(0, 14)}…`);
  const leaked = await page.evaluate((words) => {
    const vals = [...Object.keys(localStorage).map((k) => localStorage.getItem(k) ?? ''), ...Object.keys(sessionStorage).map((k) => sessionStorage.getItem(k) ?? '')];
    return vals.some((v) => words.some((w) => w.length > 3 && v.includes(w))) || (document.getElementById('seed')).value !== '';
  }, phrase.split(' '));
  record('phrase not in the box or any storage', !leaked, leaked ? 'FOUND' : 'clean');

  // A live mempool transaction: not this wallet's → refused through the real pipeline.
  const recent = await (await fetch('https://mempool.space/api/mempool/recent')).json();
  await page.fill('#tx-input', recent[0].txid);
  await page.click('#check');
  await page.waitForFunction(() => { const t = document.getElementById('plan').textContent + document.getElementById('facts').textContent; return /Not possible safely|danger|not this wallet|does not have|confirmed|Could not/i.test(t) && !/Planning|Reading/.test(t); }, null, { timeout: 120_000 });
  const verdict = (await page.textContent('#plan')) + ' ' + (await page.textContent('#facts'));
  record('foreign tx refused as not this wallet\'s', /not this wallet/i.test(verdict) || /Already confirmed/.test(verdict), verdict.replace(/\s+/g, ' ').slice(0, 200));

  await page.click('#forget');
  record('Forget locks the page', await page.isVisible('#locked') && !(await page.isVisible('#unlocked')), 'locked');
  const outside = [...hosts].filter((h) => !ALLOWED.has(h));
  record('every request went to an allowed host', outside.length === 0, `hosts: ${[...hosts].join(', ')}`);
  record('no page errors', errors.length === 0, errors.slice(0, 3).join(' | ') || 'none');
} finally {
  await browser.close();
  server?.kill();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
