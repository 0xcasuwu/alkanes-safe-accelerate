/**
 * site/src/main.ts — Accelerate CHECK: a read-only page that runs the SAME code the SUBFROST app runs to
 * decide whether a stuck alkanes transaction can be sped up safely, and exactly what would change.
 *
 * WHAT IS REUSED (bundled from subfrost-app at the commit build.mjs records):
 *   lib/accelerate/facts.ts gatherFacts   every chain fact, incl. the unconfirmed-parent derivation
 *   lib/accelerate/core.ts planAcceleration  JSON to the vendored wallet-core wasm (walletCoreAccelerate)
 *   utils/getConfig.ts                    the txid-tracked contract (frUSD) the core refuses to replace
 * WHAT IS NOT (and the page says so): signing, broadcasting, the app's storage refusals (package legs /
 * peg-outs this browser recorded) and the alkane-conservation gate (it needs SUBFROST's indexer, which
 * refuses a github.io origin). Fee coins are not offered: proving a coin alkane-free also needs the
 * indexer, so where the app would add a clean coin this page reports "no fee source".
 *
 * Never: a signing/sending wallet call, a PSBT shown or downloadable, a broadcast. build.mjs greps the
 * bundle for those method names and fails the build if one appears.
 */
import './polyfill';
import * as bitcoin from 'bitcoinjs-lib';
import initCore, * as coreGlue from '@/vendor/subfrost-wallet-core/subfrost_wallet_core_wasm.js';
import { gatherFacts, type ChainFacts } from '@/lib/accelerate/facts';
import { AccelerateRefusedError, planAcceleration, type AccelerationPlan } from '@/lib/accelerate/core';
import type { WalletCoreModule } from '@/lib/walletCore/wasm';
import type { CoreAccounts } from '@/lib/walletCore/signer';
import { getConfig } from '@/utils/getConfig';
import { FRFB_ALKANE_ID, FRFB_LEGACY_ID } from '@/lib/fractal/tokenId';
import { feePresets, publicReaders } from './readers';
import { WALLETS, type Accounts } from './wallets';

const NET = 'mainnet';
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const sats = (n: number) => `${n.toLocaleString('en-US')} sats`;
const rate2 = (r: number) => (Math.round(r * 100) / 100).toString();

/** What to do next, per refusal code (the core's message says what is wrong). */
const NEXT: Record<string, string> = {
  confirmed: 'Nothing to do: it is in a block.',
  'has-descendant': 'Another transaction already spends one of its outputs; replacing it would cancel that one. Wait, or ask how to speed up the newer one instead.',
  'not-ours': 'Read the addresses of the wallet that SENT this transaction (step 1).',
  'no-own-change': 'The transaction has no output of yours to take the extra fee from.',
  'no-fee-source': 'Your change cannot pay the higher fee. The app can add one clean coin of yours; this read-only page cannot prove a coin alkane-free, so it stops here.',
  'unknown-inscriptions': 'ordinals.com could not confirm that the sats moving into the fee carry no inscription, so nothing is planned. Try again later.',
  'inscription-to-fee': 'The extra fee would come out of inscribed sats; the app would add a clean coin instead.',
  'tracked-by-txid': 'This calls a contract that follows the transaction by its id (a peg-out). It is never replaced; ask the team.',
  'target-not-higher': 'Pick a rate above what it already pays.',
  'input-spent-elsewhere': 'One of its coins is already spent by another transaction: it can no longer confirm.',
  'unknown-data-output': 'It carries data of another protocol (Counterparty, Omni, Babylon, RGB, Stamps…) that may follow this transaction by its id. Only an accelerator that keeps the transaction as it is (below) is safe.',
  'script-recipient': 'It pays a script address with no runestone: the shape of an inscription or rune commit, a staking deposit or a Lightning channel, which another transaction may be waiting on.',
};

let core: WalletCoreModule | null = null;
let accounts: Accounts | null = null;
let facts: ChainFacts | null = null;
let presets: { fast?: number; medium?: number; slow?: number } = {};

async function loadCore(): Promise<WalletCoreModule> {
  if (!core) {
    await initCore({ module_or_path: new URL('./subfrost_wallet_core_wasm_bg.wasm', document.baseURI) });
    core = coreGlue as unknown as WalletCoreModule;
  }
  return core;
}

function coreAccounts(a: Accounts): CoreAccounts {
  const out: CoreAccounts = {};
  if (a.taproot) out.taproot = { address: a.taproot.address, pubkey_hex: a.taproot.pubkey };
  if (a.segwit) out.native_segwit = { address: a.segwit.address, pubkey_hex: a.segwit.pubkey };
  return out;
}

function ownScripts(): Set<string> {
  const out = new Set<string>();
  for (const a of [accounts?.taproot, accounts?.segwit]) {
    if (!a) continue;
    try {
      out.add(Buffer.from(bitcoin.address.toOutputScript(a.address, bitcoin.networks.bitcoin)).toString('hex'));
    } catch {
      /* not a mainnet address */
    }
  }
  return out;
}

// ─── step 1: whose transaction ────────────────────────────────────────────

function showAccounts(): void {
  const el = $('accounts');
  if (!accounts || (!accounts.taproot && !accounts.segwit)) {
    el.innerHTML = '<p class="muted">No addresses yet.</p>';
    return;
  }
  const row = (label: string, a?: { address: string }) =>
    a ? `<div class="kv"><span>${label}</span><code>${esc(a.address)}</code></div>` : '';
  el.innerHTML = `<p class="ok">Read from ${esc(accounts.from)}.</p>${row('Taproot', accounts.taproot)}${row('Native segwit', accounts.segwit)}`;
  renderFacts(); // "Yours" / "Recipient" depend on whose addresses these are
  void plan();
}

function renderWalletButtons(): void {
  const box = $('wallet-buttons');
  box.innerHTML = '';
  for (const wlt of WALLETS) {
    const b = document.createElement('button');
    b.className = 'btn secondary';
    const present = wlt.present();
    b.textContent = present ? wlt.name : `${wlt.name} (not installed)`;
    b.disabled = !present;
    b.onclick = async () => {
      $('wallet-error').textContent = '';
      try {
        const got = await wlt.read();
        if (!got.taproot && !got.segwit) throw new Error(`${wlt.name} returned no mainnet taproot or native segwit address with a public key`);
        accounts = got;
        showAccounts();
      } catch (e) {
        $('wallet-error').textContent = (e as Error).message;
      }
    };
    box.appendChild(b);
  }
}

function useManual(): void {
  const v = (id: string) => ($(id) as HTMLInputElement).value.trim();
  const a: Accounts = { from: 'manual entry' };
  if (v('m-tr-addr') && v('m-tr-key')) a.taproot = { address: v('m-tr-addr'), pubkey: v('m-tr-key') };
  if (v('m-sw-addr') && v('m-sw-key')) a.segwit = { address: v('m-sw-addr'), pubkey: v('m-sw-key') };
  if (!a.taproot && !a.segwit) {
    $('wallet-error').textContent = 'Enter at least one address with its public key.';
    return;
  }
  $('wallet-error').textContent = '';
  accounts = a;
  showAccounts();
}

// ─── step 2: the transaction ──────────────────────────────────────────────

async function check(): Promise<void> {
  const raw = ($('tx-input') as HTMLTextAreaElement).value.trim();
  facts = null;
  $('facts').innerHTML = '';
  $('plan').innerHTML = '';
  if (!raw) return;
  const isTxid = /^[0-9a-f]{64}$/i.test(raw);
  if (isTxid) history.replaceState(null, '', `?txid=${raw.toLowerCase()}`);
  $('facts').innerHTML = '<p class="muted">Reading the transaction from mempool.space and ordinals.com…</p>';
  try {
    facts = await gatherFacts(isTxid ? { txid: raw } : { rawHex: raw }, publicReaders);
  } catch (e) {
    $('facts').innerHTML = `<p class="danger">${esc((e as Error).message)}</p>`;
    return;
  }
  renderFacts();
  await plan();
}

function renderFacts(): void {
  if (!facts) return;
  const tx = bitcoin.Transaction.fromHex(facts.originalHex);
  const fee = facts.prevouts.reduce((s, p) => s + p.value, 0) - tx.outs.reduce((s, o) => s + Number(o.value), 0);
  const rate = fee / tx.virtualSize();
  const status =
    facts.status === 'confirmed' ? 'Already confirmed. Nothing to do.'
      : facts.status === 'absent' ? 'mempool.space does not have this transaction (it may have been dropped, or it may still sit on other nodes).'
        : `Waiting in the mempool, paying ${rate2(rate)} sat/vB (${sats(fee)}).`;
  const mine = ownScripts();
  const rows = tx.outs.map((o, i) => {
    const hex = Buffer.from(o.script).toString('hex');
    const label = hex.startsWith('6a') ? 'Data (protostones)' : mine.has(hex) ? 'Yours' : 'Recipient';
    return `<tr data-vout="${i}"><td>#${i}</td><td>${sats(Number(o.value))}</td><td>${label}</td><td class="reach"></td></tr>`;
  }).join('');
  const ins = facts.inputInscriptions.map((s, i) => `#${i} ${s.kind === 'none' ? 'no inscription' : s.kind === 'at' ? `inscribed at ${s.offsets.join(', ')}` : 'unknown'}`).join(' · ');
  $('facts').innerHTML = `
    <p>${esc(status)}</p>
    ${facts.ancestors ? `<p class="muted">It waits on unconfirmed parents (${facts.ancestors.vsize.toLocaleString('en-US')} vB); the new fee must lift them too.</p>` : ''}
    <table class="outs"><thead><tr><th>Output</th><th>Value</th><th>Whose</th><th></th></tr></thead><tbody>${rows}</tbody></table>
    <p class="muted small">Inputs (ordinals.com): ${esc(ins)}</p>`;
  const r = $('rate') as HTMLInputElement;
  if (!r.value) r.value = String(Math.max(presets.fast ?? 0, Math.ceil((rate + 1) * 10) / 10));
}

function targetRate(): number | null {
  const v = Number(($('rate') as HTMLInputElement).value.replace(',', '.'));
  return Number.isFinite(v) && v > 0 ? v : null;
}

async function plan(): Promise<void> {
  const out = $('plan');
  if (!facts || facts.status === 'confirmed') {
    out.innerHTML = '';
    return;
  }
  if (!accounts) {
    out.innerHTML = '<p class="muted">Read your wallet\'s addresses (step 1) to see the plan.</p>';
    return;
  }
  const rate = targetRate();
  if (rate === null) {
    out.innerHTML = '<p class="danger">Enter a fee rate in sat/vB.</p>';
    return;
  }
  out.innerHTML = '<p class="muted">Working out a safe replacement…</p>';
  const frusd = getConfig(NET).FRUSD_TOKEN_ID as string | undefined;
  const tracked = [frusd, FRFB_ALKANE_ID, FRFB_LEGACY_ID].filter((t): t is string => typeof t === 'string' && t.length > 0);
  const run = async (fx: ChainFacts, attestPlainPayment: boolean) =>
    planAcceleration({ network: NET, accounts: coreAccounts(accounts as Accounts), facts: fx, feeCoins: [], trackedTargets: tracked, targetFeeRate: rate, attestPlainPayment }, await loadCore());
  const refusedHtml = (e: Error, extra = '') => {
    const code = e instanceof AccelerateRefusedError ? e.code : '';
    return `<div class="refused"><p class="danger"><b>Not possible safely:</b> ${esc(e.message)}</p>
      ${NEXT[code] ? `<p>${esc(NEXT[code])}</p>` : ''}${extra}
      <p class="muted small">If it must confirm sooner anyway, an accelerator that pays a miner WITHOUT changing the transaction (for example mempool.space Accelerator) does not touch your assets. Never combine it with a wallet Speed Up.</p></div>`;
  };
  // Two refusals become labelled CONDITIONS here (nothing is signed on this page; the app decides each
  // for real): inscriptions this page could not read (assumed none), and a script recipient (assumed a
  // plain payment, which in the app the user must state explicitly).
  const unknown = facts.inputInscriptions.flatMap((s, i) => (s.kind === 'unknown' ? [i] : []));
  let f = facts;
  let attest = false;
  let unverified: number[] = [];
  let p: AccelerationPlan | null = null;
  for (let tries = 0; tries < 3 && !p; tries++) {
    try {
      p = await run(f, attest);
    } catch (e) {
      const code = e instanceof AccelerateRefusedError ? e.code : '';
      if (code === 'unknown-inscriptions' && unknown.length > 0 && unverified.length === 0) {
        f = { ...f, inputInscriptions: f.inputInscriptions.map((s) => (s.kind === 'unknown' ? { kind: 'none' as const } : s)) };
        unverified = unknown;
      } else if (code === 'script-recipient' && !attest) {
        attest = true;
      } else {
        out.innerHTML = refusedHtml(e as Error, unverified.length ? `<p class="muted small">(Inscriptions on inputs #${unverified.join(', #')} could not be checked here.)</p>` : '');
        return;
      }
    }
  }
  if (!p) return;
  for (const v of p.alkanesReachable ?? []) {
    const cell = document.querySelector(`tr[data-vout="${v}"] .reach`);
    if (cell) cell.textContent = 'alkanes may land here';
  }
  const what =
    p.strategy === 'rebroadcast' ? 'Send the original again, byte for byte.'
      : p.strategy === 'shrink-change' ? `Take the extra fee from your output #${p.changedVout}: ${sats(p.changeFrom ?? 0)} → ${sats(p.changeTo ?? 0)}. Every other output, the order and the protostones stay identical.`
        : `Add one clean coin (${esc(p.coin ?? '')}); output #${p.changedVout} becomes ${sats(p.changeTo ?? 0)}.`;
  const conditions: string[] = [];
  if (unverified.length === 1) conditions.push(`input #${unverified[0]} carries no inscription (ordinals.com could not be read here; the app checks it)`);
  if (unverified.length > 1) conditions.push(`inputs #${unverified.join(', #')} carry no inscription (ordinals.com could not be read here; the app checks them)`);
  if (attest) conditions.push('this is a plain payment that nothing else waits on: no inscription or rune reveal, staking position, Lightning channel, swap or bridge (the app asks you to state it)');
  const head = conditions.length === 0
    ? '<p class="ok"><b>Safe to accelerate.</b> '
    : `<p class="warn"><b>Safe only if</b> ${esc(conditions.join('; and '))}. `;
  const tail = p.strategy === 'shrink-change'
    ? `<p class="muted small">The last ${sats((p.changeFrom ?? 0) - (p.changeTo ?? 0))} of output #${p.changedVout} move into the fee. Inscriptions there are checked; rare sats and Atomicals are not indexed anywhere SUBFROST reads, so if this wallet holds them, move them first.</p>`
    : '';
  out.innerHTML = `<div class="planbox">
    ${head}${what}</p>
    <p class="muted">New fee: ${sats(p.feeSats)} (at most ${rate2(p.feeSats / p.vsizeWorst)} sat/vB), was ${sats(p.originalFeeSats)}.</p>
    ${tail}
    <p class="small">This page only checks. To accelerate, use <b>Accelerate</b> in the SUBFROST app (Activity → Speed Up), which builds exactly this, runs the alkane-conservation gate, simulates the original and the replacement to confirm they settle alike, has your wallet sign, and re-verifies the signed bytes before broadcasting.</p>
  </div>`;
}

// ─── boot ─────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  renderWalletButtons();
  showAccounts();
  // Wallets inject after load on some browsers: re-render once they had a moment.
  setTimeout(renderWalletButtons, 800);
  $('manual-use').onclick = useManual;
  $('check').onclick = () => void check();
  let t: ReturnType<typeof setTimeout> | undefined;
  $('rate').oninput = () => {
    clearTimeout(t);
    t = setTimeout(() => void plan(), 300);
  };
  presets = await feePresets();
  const pb = $('presets');
  pb.innerHTML = '';
  for (const [k, label] of [['fast', 'Next block'], ['medium', '~30 min'], ['slow', '~1 hour']] as const) {
    const v = presets[k];
    if (!v) continue;
    const b = document.createElement('button');
    b.className = 'btn ghost';
    b.textContent = `${label} · ${v}`;
    b.onclick = () => {
      ($('rate') as HTMLInputElement).value = String(v);
      void plan();
    };
    pb.appendChild(b);
  }
  const txid = new URLSearchParams(location.search).get('txid');
  if (txid && /^[0-9a-f]{64}$/i.test(txid)) {
    ($('tx-input') as HTMLTextAreaElement).value = txid;
    void check();
  }
  void loadCore().catch((e) => {
    $('plan').innerHTML = `<p class="danger">The engine did not load (${esc((e as Error).message)}).</p>`;
  });
}

void boot();
