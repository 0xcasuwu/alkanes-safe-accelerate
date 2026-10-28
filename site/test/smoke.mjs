// site/test/smoke.mjs — drives the BUILT read-only checker (docs/check/) in Chromium against live mainnet data.
//
//   node site/test/smoke.mjs [path-to-subfrost-app-checkout]   (uses its Playwright install)
//   BASE_URL=https://0xcasuwu.github.io/alkanes-safe-accelerate/check/ node site/test/smoke.mjs   (the LIVE page)
//
// Candidates are found at run time, never hardcoded:
//   confirmed   a tx from the tip block                        → "Already confirmed"
//   ownable     a mempool tx whose inputs are all p2wpkh from ONE address that also receives the last
//               output: the witness reveals that address's public key, so the full plan path runs with
//               manual entry and no wallet → a plan, or one of the core's named refusals
//   no account  the same tx before any address is entered      → asks for the wallet's addresses
//   foreign     the same tx read as someone else's (a random key's address) → refused, not-ours
//   garbage     not a txid                                     → an error, nothing planned
// Console errors fail the run. A screenshot of the plan lands next to the log.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.resolve(here, '../../docs/check');
const app = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'Documents/wt-accel-app'));
const require = createRequire(path.join(app, 'package.json'));
const { chromium } = require('@playwright/test');
const bitcoin = require('bitcoinjs-lib');
const ecc = require('@bitcoinerlab/secp256k1');
bitcoin.initEccLib(ecc);
const shotDir = process.env.SHOT_DIR ?? os.tmpdir();
const M = 'https://mempool.space/api';
const j = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u} ${r.status}`); return r.json(); };
const t = async (u) => { const r = await fetch(u); if (!r.ok) throw new Error(`${u} ${r.status}`); return (await r.text()).trim(); };

async function findOwnable() {
  for (let round = 0; round < 12; round++) {
    for (const { txid } of await j(`${M}/mempool/recent`)) {
      const tx = await j(`${M}/tx/${txid}`).catch(() => null);
      if (!tx || tx.status?.confirmed) continue;
      const addrs = new Set(tx.vin.map((v) => v.prevout?.scriptpubkey_address));
      if (addrs.size !== 1 || !tx.vin.every((v) => v.prevout?.scriptpubkey_type === 'v0_p2wpkh' && v.witness?.length === 2 && v.witness[1].length === 66)) continue;
      const [address] = addrs;
      const outs = tx.vout.filter((o) => o.scriptpubkey_type !== 'op_return' && o.value > 0);
      const last = outs[outs.length - 1];
      if (!last || last.scriptpubkey_address !== address || last.value <= 5_000) continue;
      return { txid, address, pubkey: tx.vin[0].witness[1], rate: tx.fee / (tx.weight / 4) };
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
  throw new Error('no ownable mempool tx found in 12 rounds');
}

const results = [];
const record = (name, pass, detail) => { results.push({ name, pass, detail }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name} — ${detail}`); };

const port = 4100 + Math.floor(Math.random() * 800);
const server = process.env.BASE_URL ? null : spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', docs], { stdio: 'ignore' });
const browser = await chromium.launch();
try {
  await new Promise((r) => setTimeout(r, 800));
  const tip = await t(`${M}/blocks/tip/hash`);
  const confirmed = await t(`${M}/block/${tip}/txid/1`);
  const own = await findOwnable();
  console.log(`ownable ${own.txid} at ${own.rate.toFixed(2)} sat/vB, ${own.address}`);

  const page = await browser.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  const base = process.env.BASE_URL ?? `http://127.0.0.1:${port}/`;
  await page.goto(base);
  await page.waitForSelector('#presets button', { timeout: 30_000 }).catch(() => {});
  record('page loads with fee presets', (await page.locator('#presets button').count()) > 0, `${await page.locator('#presets button').count()} presets`);

  const check = async (value) => {
    await page.fill('#tx-input', value);
    await page.click('#check');
    await page.waitForFunction(() => !/Reading the transaction/.test(document.getElementById('facts').textContent), null, { timeout: 90_000 });
  };
  const planText = async () => {
    await page.waitForFunction(() => { const p = document.getElementById('plan').textContent; return p && !/Working out/.test(p); }, null, { timeout: 60_000 });
    return (await page.locator('#plan').innerText()).replace(/\s+/g, ' ');
  };

  await check(confirmed);
  record('confirmed tx', /Already confirmed/.test(await page.locator('#facts').innerText()), (await page.locator('#facts').innerText()).slice(0, 80));

  await check(own.txid);
  const facts = await page.locator('#facts').innerText();
  record('mempool tx facts', /Waiting in the mempool/.test(facts), facts.split('\n')[0]);
  const noAcct = await planText();
  record('no account → asks for addresses', /Read your wallet/.test(noAcct), noAcct.slice(0, 80));

  // Someone else's address (a fresh random key): the core must refuse it as not ours.
  const stranger = ecc.pointFromScalar(randomBytes(32), true);
  const strangerAddr = bitcoin.payments.p2wpkh({ pubkey: Buffer.from(stranger) }).address;
  await page.click('details summary');
  await page.fill('#m-sw-addr', strangerAddr);
  await page.fill('#m-sw-key', Buffer.from(stranger).toString('hex'));
  await page.click('#manual-use');
  await page.fill('#rate', String(Math.ceil(own.rate + 5)));
  const foreign = await planText();
  record('foreign wallet → refused (not ours)', /Not possible safely/.test(foreign) && /SENT this transaction|not this wallet/.test(foreign), foreign.slice(0, 140));

  // The owner's address + the pubkey its witness revealed.
  await page.fill('#m-sw-addr', own.address);
  await page.fill('#m-sw-key', own.pubkey);
  await page.click('#manual-use');
  const p = await planText();
  const planned = /Safe to accelerate|Safe only if/.test(p);
  const namedRefusal = /Not possible safely/.test(p);
  record('owner → plan or a named refusal', planned || namedRefusal, p.slice(0, 220));
  const lastRow = (await page.locator('table.outs tbody tr').last().innerText()).replace(/\s+/g, ' ');
  record('the owner\'s change reads "Yours" once the address is entered', /Yours/.test(lastRow), lastRow);
  if (planned) record('plan keeps everything but the change', /Every other output, the order and the protostones stay identical|Send the original again/.test(p), 'plan text');
  await page.screenshot({ path: path.join(shotDir, 'accelerate-check-plan.png'), fullPage: true });

  await check('not-a-txid');
  record('garbage input → error', /not a raw Bitcoin transaction|not a transaction id/i.test(await page.locator('#facts').innerText()), (await page.locator('#facts').innerText()).slice(0, 80));

  // ordinals.com refusing the browser (403/406 without CORS headers) is expected and handled (the plan is
  // then labelled conditional); every OTHER console error fails the run.
  const real = errors.filter((e) => !/ordinals\.com|Failed to load resource: (net::ERR_FAILED|the server responded with a status of 40[36])/.test(e));
  record('no console errors (beyond ordinals.com refusals)', real.length === 0, real.slice(0, 3).join(' | ') || `none (${errors.length - real.length} ordinals.com refusals)`);
} finally {
  await browser.close();
  server?.kill();
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
