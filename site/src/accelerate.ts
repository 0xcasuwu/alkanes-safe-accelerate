/**
 * site/src/accelerate.ts — the accelerator: the SUBFROST app's alkanes-safe Speed Up, signed by a keystore held in
 * THIS TAB'S MEMORY ONLY. Built into local/ and run on the user's own computer by accelerate.sh (site/serve-local.mjs).
 *
 * THE PIPELINE IS THE APP'S, not a copy (bundled from subfrost-app at the commit build.mjs stamps):
 *   lib/accelerate/run.ts      inspect → plan (+ sat-flow and alkane-conservation preflight, and the
 *                              original-vs-replacement settlement simulation) → sign → re-read → verify
 *                              the signed bytes → settlement again on them → testmempoolaccept → last look
 *                              → broadcast (or stop there: "Check" is the dry run)
 *   lib/walletCore/signer.ts   signThroughCore: the core's signing request, prevout proof, sat-flow check,
 *                              the keystore signs, the core verifies the signed PSBT
 *   lib/walletCore/keystoreSigner.ts  keys derived per signature from the mnemonic and dropped after
 * Reads, testmempoolaccept and the broadcast go to the same-origin /api/rpc/mainnet, as in the app; the local
 * server forwards them to SUBFROST's gateway. Why local and not GitHub Pages (2026-10-28): the gateway refuses
 * browser requests from origins its key does not list (403 CORS_BLOCKED for github.io and localhost alike), and a
 * program's request carries no origin. The earlier Pages variant (rpcShim.ts → a keyed gateway) is removed.
 *
 * THE SEED (operator 2026-10-27: a POC, seeds on the page are acceptable). Held in ONE module variable,
 * never written to any storage and never passed to anything but the keystore signer; reload, close or
 * "Forget" drops it. The page's Content-Security-Policy (accelerate.html) allows network connections to
 * the page's own server, mempool.space and ordinals.com only, so nothing bundled can send it elsewhere.
 *
 * NOT HERE (stated on the page): fee coins (shrink-change only: proving a coin alkane-free needs the
 * wallet snapshot the app's server builds), and the app's local records of in-flight packages and
 * peg-outs (the core still refuses txid-tracked contracts from the bytes on any device).
 */
import './polyfill';
import * as bitcoin from 'bitcoinjs-lib';
import * as bip39 from 'bip39';
import initCore, * as coreGlue from '@/vendor/subfrost-wallet-core/subfrost_wallet_core_wasm.js';
import type { WalletCoreModule } from '@/lib/walletCore/wasm';
import type { CoreAccounts } from '@/lib/walletCore/signer';
import { signThroughCore } from '@/lib/walletCore/signer';
import { KeystoreSigner, keystoreAccounts } from '@/lib/walletCore/keystoreSigner';
import { finalizeAndExtract } from '@/lib/walletCore/finalize';
import { coreIntentOf, assertPreSignTs } from '@/lib/signing/preSign';
import { assertAlkanesConservedPreSign, rpcConservationReaders } from '@/lib/signing/alkaneGate';
import { broadcastTransaction, testMempoolAccept } from '@/lib/alkanes/rpc';
import { rpcFactReaders, type ChainFacts } from '@/lib/accelerate/facts';
import { AccelerateRefusedError, type AccelerationPlan } from '@/lib/accelerate/core';
import { assertSettlesLikeOriginal } from '@/lib/accelerate/differential';
import { execute, inspect, plan, type AccelerateDeps, type Inspection } from '@/lib/accelerate/run';
import { getConfig } from '@/utils/getConfig';
import { FRFB_ALKANE_ID, FRFB_LEGACY_ID } from '@/lib/fractal/tokenId';
import { feePresets } from './readers';

const NET = 'mainnet';
const BTC = bitcoin.networks.bitcoin;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const sats = (n: number) => `${n.toLocaleString('en-US')} sats`;
const rate2 = (r: number) => (Math.round(r * 100) / 100).toString();
const TRACKED = [getConfig(NET).FRUSD_TOKEN_ID as string | undefined, FRFB_ALKANE_ID, FRFB_LEGACY_ID].filter((t): t is string => typeof t === 'string' && t.length > 0);

// ── the only place the seed lives ──
let mnemonic: string | null = null;
let accountIndex = 0;
let accounts: Required<CoreAccounts> | null = null;

let core: WalletCoreModule | null = null;
let inspection: Inspection | null = null;
let chosen: AccelerationPlan | null = null;
let attest = false;
let absentAck = false;
let presets: { fast?: number; medium?: number; slow?: number } = {};
let busy = false;

async function loadCore(): Promise<WalletCoreModule> {
  if (!core) {
    await initCore({ module_or_path: new URL('./subfrost_wallet_core_wasm_bg.wasm', document.baseURI) });
    core = coreGlue as unknown as WalletCoreModule;
  }
  return core;
}

const ownAddresses = (): string[] => (accounts ? Object.values(accounts).map((a) => a.address) : []);

function deps(c: WalletCoreModule): AccelerateDeps {
  if (!accounts) throw new Error('Unlock a keystore first');
  const acct = accounts;
  const own = ownAddresses();
  return {
    network: NET,
    accounts: acct,
    ownAddresses: own,
    readers: rpcFactReaders(NET),
    feeCoins: async () => [],
    trackedTargets: TRACKED,
    storageRefusal: () => null,
    preflight: async (b64) => {
      assertPreSignTs(b64, NET, own);
      await assertAlkanesConservedPreSign(b64, NET);
    },
    settles: (originalHex, replacementHex) => assertSettlesLikeOriginal(originalHex, replacementHex, rpcConservationReaders(NET), true),
    sign: async (b64) => {
      // The app runs the alkane gate again at signing (WalletContext signViaCore), then the core contract.
      await assertAlkanesConservedPreSign(b64, NET);
      const signer = new KeystoreSigner({ readMnemonic: () => mnemonic, network: NET, index: accountIndex, core: c });
      const { signedPsbtBase64 } = await signThroughCore({
        psbtBase64: b64, network: NET, accounts: acct, signer, core: c,
        intent: coreIntentOf(b64, NET, BTC, own),
      });
      return signedPsbtBase64;
    },
    finalize: async (signed) => (await finalizeAndExtract(bitcoin.Psbt.fromBase64(signed, { network: BTC }))).toHex(),
    testAccept: (hex) => testMempoolAccept(NET, hex),
    broadcast: (hex) => broadcastTransaction(NET, hex),
    recordPending: async () => {},
    core: c,
  };
}

// ─── keystore ─────────────────────────────────────────────────────────────

async function unlock(): Promise<void> {
  const box = $('seed') as HTMLTextAreaElement;
  const words = box.value.trim().toLowerCase().split(/\s+/).join(' ');
  box.value = ''; // out of the DOM at once, valid or not
  $('seed-error').textContent = '';
  if (!bip39.validateMnemonic(words)) {
    $('seed-error').textContent = 'That is not a valid BIP39 recovery phrase.';
    return;
  }
  accountIndex = Math.max(0, Math.floor(Number(($('acct-index') as HTMLInputElement).value) || 0));
  try {
    accounts = await keystoreAccounts(words, NET, accountIndex, await loadCore());
    mnemonic = words;
  } catch (e) {
    accounts = null;
    mnemonic = null;
    $('seed-error').textContent = (e as Error).message;
    return;
  }
  renderWallet();
  void replan();
}

function forget(): void {
  mnemonic = null;
  accounts = null;
  chosen = null;
  renderWallet();
  void replan();
}

function renderWallet(): void {
  const on = !!accounts;
  $('locked').hidden = on;
  $('unlocked').hidden = !on;
  if (!accounts) return;
  $('addresses').innerHTML = (['taproot', 'native_segwit', 'nested_segwit', 'legacy'] as const)
    .map((k) => `<div class="kv"><span>${k.replace('_', ' ')}</span><code>${esc(accounts![k].address)}</code></div>`).join('');
}

// ─── the transaction ──────────────────────────────────────────────────────

async function check(): Promise<void> {
  const raw = ($('tx-input') as HTMLTextAreaElement).value.trim();
  inspection = null;
  chosen = null;
  attest = false;
  absentAck = false;
  $('facts').innerHTML = '';
  $('plan').innerHTML = '';
  $('result').innerHTML = '';
  if (!raw) return;
  if (!accounts) {
    $('facts').innerHTML = '<p class="muted">Unlock the keystore that sent it first (step 1).</p>';
    return;
  }
  const isTxid = /^[0-9a-f]{64}$/i.test(raw);
  $('facts').innerHTML = '<p class="muted">Reading the transaction from the SUBFROST gateway…</p>';
  try {
    inspection = await inspect(isTxid ? { txid: raw } : { rawHex: raw }, deps(await loadCore()));
  } catch (e) {
    $('facts').innerHTML = `<p class="danger">${esc((e as Error).message)}</p>`;
    return;
  }
  renderFacts(inspection.facts);
  await replan();
}

function renderFacts(f: ChainFacts): void {
  const tx = bitcoin.Transaction.fromHex(f.originalHex);
  const fee = f.prevouts.reduce((s, p) => s + p.value, 0) - tx.outs.reduce((s, o) => s + Number(o.value), 0);
  const rate = fee / tx.virtualSize();
  const status =
    f.status === 'confirmed' ? 'Already confirmed. Nothing to do.'
      : f.status === 'absent' ? 'The gateway does not have this transaction (it may have been dropped, or it may still sit on other nodes). If it still exists elsewhere, it and the replacement compete; both pay the same recipients and route the alkanes the same way.'
        : `Waiting in the mempool, paying ${rate2(rate)} sat/vB (${sats(fee)}).`;
  const own = new Set(ownAddresses().map((a) => Buffer.from(bitcoin.address.toOutputScript(a, BTC)).toString('hex')));
  const rows = tx.outs.map((o, i) => {
    const hex = Buffer.from(o.script).toString('hex');
    const label = hex.startsWith('6a') ? 'Data (protostones)' : own.has(hex) ? 'Yours' : 'Recipient';
    return `<tr><td>#${i}</td><td>${sats(Number(o.value))}</td><td>${label}</td></tr>`;
  }).join('');
  $('facts').innerHTML = `<p>${esc(status)}</p>
    <table class="outs"><thead><tr><th>Output</th><th>Value</th><th>Whose</th></tr></thead><tbody>${rows}</tbody></table>`;
  const r = $('rate') as HTMLInputElement;
  if (!r.value) r.value = String(Math.max(presets.fast ?? 0, Math.ceil((rate + 1) * 10) / 10));
}

function targetRate(): number | null {
  const v = Number(($('rate') as HTMLInputElement).value.replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

async function replan(): Promise<void> {
  const out = $('plan');
  chosen = null;
  $('result').innerHTML = '';
  if (!inspection || !accounts || inspection.facts.status === 'confirmed') {
    out.innerHTML = '';
    return;
  }
  const rate = targetRate();
  if (rate === null) {
    out.innerHTML = '<p class="danger">Enter a fee rate in sat/vB.</p>';
    return;
  }
  out.innerHTML = '<p class="muted">Planning, then running the signing checks and the settlement simulation…</p>';
  try {
    chosen = await plan(inspection, rate, deps(await loadCore()), { attestPlainPayment: attest });
  } catch (e) {
    const code = e instanceof AccelerateRefusedError ? e.code : '';
    out.innerHTML = `<div class="refused"><p class="danger"><b>Not possible safely:</b> ${esc((e as Error).message)}</p>
      ${code === 'script-recipient' ? `<label class="tick"><input type="checkbox" id="attest"> This is a plain payment I made to a person or an exchange. Nothing else is waiting on this transaction: no inscription or rune reveal, staking position, Lightning channel, swap or bridge.</label>` : ''}
      <p class="muted small">If it must confirm sooner anyway, an accelerator that pays a miner WITHOUT changing the transaction (for example mempool.space Accelerator) does not touch your assets.</p></div>`;
    const a = document.getElementById('attest') as HTMLInputElement | null;
    if (a) a.onchange = () => { attest = a.checked; void replan(); };
    return;
  }
  const p = chosen;
  const what =
    p.strategy === 'rebroadcast' ? 'Send the original again, byte for byte.'
      : `Take the extra fee from your output #${p.changedVout}: ${sats(p.changeFrom ?? 0)} → ${sats(p.changeTo ?? 0)}. Every other output, the order and the protostones stay identical.`;
  const needsAck = inspection.facts.status === 'absent' && p.strategy !== 'rebroadcast';
  out.innerHTML = `<div class="planbox">
    <p class="ok"><b>Safe to accelerate.</b> ${what}</p>
    <p class="muted">New fee: ${sats(p.feeSats)} (at most ${rate2(p.feeSats / p.vsizeWorst)} sat/vB), was ${sats(p.originalFeeSats)}.</p>
    ${p.strategy === 'shrink-change' ? `<p class="muted small">The last ${sats((p.changeFrom ?? 0) - (p.changeTo ?? 0))} of output #${p.changedVout} move into the fee. Inscriptions there are checked; rare sats and Atomicals are not indexed, so if this wallet holds them, move them first.</p>` : ''}
    <p class="muted small">Checked already: sat flow, alkane conservation, and the original and the replacement settle identically (simulated).</p>
    ${attest ? '<p class="warn small">This plan relies on your statement that this is a plain payment nothing else waits on.</p>' : ''}
    ${needsAck ? '<label class="tick"><input type="checkbox" id="absent-ack"> I understand the original may still confirm instead.</label>' : ''}
    <div class="row">
      <button class="btn secondary" id="do-check">Check: sign and verify, don't broadcast</button>
      <button class="btn primary" id="do-send">Accelerate: sign and broadcast</button>
    </div>
  </div>`;
  const ack = document.getElementById('absent-ack') as HTMLInputElement | null;
  if (ack) ack.onchange = () => { absentAck = ack.checked; };
  $('do-check').onclick = () => void run(true);
  $('do-send').onclick = () => void run(false);
}

async function run(dryRun: boolean): Promise<void> {
  if (busy || !inspection || !chosen) return;
  if (inspection.facts.status === 'absent' && chosen.strategy !== 'rebroadcast' && !absentAck) {
    $('result').innerHTML = '<p class="danger">Tick the acknowledgement above first.</p>';
    return;
  }
  busy = true;
  $('result').innerHTML = `<p class="muted">${dryRun ? 'Signing and checking (nothing will be broadcast)…' : 'Signing, checking, then broadcasting…'}</p>`;
  const raw = ($('tx-input') as HTMLTextAreaElement).value.trim();
  const target = /^[0-9a-f]{64}$/i.test(raw) ? { txid: raw } : { rawHex: raw };
  try {
    const rate = targetRate() ?? 0;
    const o = await execute(target, inspection, chosen, rate, deps(await loadCore()), { attestPlainPayment: attest, dryRun });
    $('result').innerHTML = o.dryRun
      ? `<div class="planbox"><p class="ok"><b>Checked. Nothing was broadcast.</b> The keystore signed <code>${o.txid}</code>; the signed bytes were verified, the node accepted it (testmempoolaccept) and it settles like the original. Fee ${sats(o.feeSats)} (${rate2(o.feeRate)} sat/vB).</p>
         <details class="small"><summary>Signed bytes (never broadcast)</summary><code id="signed-hex">${o.dryRun.signedHex}</code></details></div>`
      : `<div class="planbox"><p class="ok"><b>Accelerated.</b> The faster transaction is <a href="https://mempool.space/tx/${o.txid}" target="_blank" rel="noreferrer"><code>${o.txid}</code></a>, paying ${sats(o.feeSats)} (${rate2(o.feeRate)} sat/vB).</p></div>`;
  } catch (e) {
    $('result').innerHTML = `<p class="danger"><b>Stopped:</b> ${esc((e as Error).message)}</p>`;
  } finally {
    busy = false;
  }
}

// ─── boot ─────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  renderWallet();
  $('unlock').onclick = () => void unlock();
  $('forget').onclick = forget;
  $('check').onclick = () => void check();
  let t: ReturnType<typeof setTimeout> | undefined;
  $('rate').oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => void replan(), 400);
  };
  window.addEventListener('pagehide', () => { mnemonic = null; });
  presets = await feePresets();
  const pb = $('presets');
  for (const [k, label] of [['fast', 'Next block'], ['medium', '~30 min'], ['slow', '~1 hour']] as const) {
    const v = presets[k];
    if (!v) continue;
    const b = document.createElement('button');
    b.className = 'btn ghost';
    b.textContent = `${label} · ${v}`;
    b.onclick = () => { ($('rate') as HTMLInputElement).value = String(v); void replan(); };
    pb.appendChild(b);
  }
  void loadCore().catch((e) => { $('plan').innerHTML = `<p class="danger">The engine did not load (${esc((e as Error).message)}).</p>`; });
}

void boot();
