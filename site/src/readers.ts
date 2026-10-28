/**
 * site/src/readers.ts — the app's FactReaders (lib/accelerate/facts.ts) served from public, CORS-open
 * sources, because SUBFROST's own indexer refuses a github.io origin (403, checked 2026-10-27):
 *   mempool.space esplora   status, bytes, outspends, ancestors' fee/weight, tip height, fee estimates
 *   ordinals.com            inscription status per input, with satpoint offsets
 * Same contract as the app's readers: a positive "not found" is null, anything unreadable THROWS (or
 * reads 'unknown' for inscriptions). Nothing unreadable ever passes as "unspent" or "not inscribed".
 *
 * ORD ACCEPTANCE (the app's rule, lib/alkanes/ordRow.ts, plus one more): an answer counts only when ord
 * indexed the output AND it is unspent in ord's view. A SPENT output reads `indexed:false,
 * inscriptions: []` (probed 2026-10-27): its inscriptions moved on, so that empty list must never read
 * as "none". Only a 404 (ord does not know the output: its block is not indexed yet) is `unindexed`,
 * which the app's derivation (facts.ts unconfirmedParentStatuses) may use for an unconfirmed parent.
 * ordinals.com is NOT dependable from a browser (probed 2026-10-27): it answers `406 JSON API
 * disabled` to JSON requests (even for an outpoint it had answered an hour earlier) and 403 to a
 * headless user agent. Those are 'unknown', never 'unindexed'; main.ts then shows a plan labelled
 * conditional on those inputs, which the app verifies against SUBFROST's indexer before signing.
 */
import type { EsploraOutspend, EsploraTransaction } from '@/lib/alkanes/rpc';
import type { FactReaders, InscriptionsIn } from '@/lib/accelerate/facts';

const MEMPOOL = 'https://mempool.space/api';
const ORD = 'https://ordinals.com';
const TIMEOUT_MS = 15_000;

async function get(url: string, accept?: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), headers: accept ? { Accept: accept } : undefined });
}

async function okText(url: string): Promise<string> {
  const r = await get(url);
  if (!r.ok) throw new Error(`${url} answered ${r.status}`);
  return (await r.text()).trim();
}

interface OrdOutputJson {
  indexed?: boolean;
  spent?: boolean;
  inscriptions?: unknown;
}

async function ordStatus(outpoint: string): Promise<InscriptionsIn> {
  let r: Response;
  try {
    r = await get(`${ORD}/output/${outpoint}`, 'application/json');
  } catch {
    return { kind: 'unknown' };
  }
  if (r.status === 404) return { kind: 'unknown', unindexed: true };
  if (!r.ok) return { kind: 'unknown' };
  let j: OrdOutputJson;
  try {
    j = (await r.json()) as OrdOutputJson;
  } catch {
    return { kind: 'unknown' };
  }
  if (j.indexed !== true || j.spent === true || !Array.isArray(j.inscriptions)) return { kind: 'unknown' };
  if (j.inscriptions.length === 0) return { kind: 'none' };
  // Inscribed: each inscription's satpoint must name THIS outpoint; its offset is where it sits.
  const offsets: number[] = [];
  for (const id of j.inscriptions) {
    if (typeof id !== 'string') return { kind: 'unknown' };
    try {
      const ir = await get(`${ORD}/inscription/${id}`, 'application/json');
      if (!ir.ok) return { kind: 'unknown' };
      const sp = ((await ir.json()) as { satpoint?: unknown }).satpoint;
      if (typeof sp !== 'string') return { kind: 'unknown' };
      const at = sp.lastIndexOf(':');
      if (sp.slice(0, at) !== outpoint) return { kind: 'unknown' };
      const off = Number(sp.slice(at + 1));
      if (!Number.isSafeInteger(off) || off < 0) return { kind: 'unknown' };
      offsets.push(off);
    } catch {
      return { kind: 'unknown' };
    }
  }
  return { kind: 'at', offsets };
}

export const publicReaders: FactReaders = {
  async lookupTx(txid): Promise<EsploraTransaction | null> {
    const r = await get(`${MEMPOOL}/tx/${txid}`);
    if (r.status === 404) return null; // "Transaction not found": a positive answer
    if (!r.ok) throw new Error(`mempool.space answered ${r.status}`);
    const j = (await r.json()) as EsploraTransaction;
    if (!j || !Array.isArray(j.vin)) throw new Error('mempool.space returned an unrecognised transaction');
    return j;
  },
  txHex: (txid) => okText(`${MEMPOOL}/tx/${txid}/hex`),
  async outspend(txid, vout): Promise<EsploraOutspend | null> {
    try {
      const r = await get(`${MEMPOOL}/tx/${txid}/outspend/${vout}`);
      if (!r.ok) return null;
      return (await r.json()) as EsploraOutspend;
    } catch {
      return null; // unreadable: gatherFacts refuses on it
    }
  },
  async indexerHeight() {
    const n = Number(await okText(`${MEMPOOL}/blocks/tip/height`));
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error('bad tip height');
    return n;
  },
  async inscriptions(inputs) {
    const out: InscriptionsIn[] = [];
    for (const i of inputs) out.push(await ordStatus(i.outpoint)); // sequential: be gentle with ordinals.com
    return out;
  },
};

/** mempool.space's own estimates, sat/vB, for the rate presets. */
export async function feePresets(): Promise<{ fast?: number; medium?: number; slow?: number }> {
  try {
    const r = await get(`${MEMPOOL}/v1/fees/recommended`);
    if (!r.ok) return {};
    const j = (await r.json()) as Record<string, unknown>;
    const n = (k: string) => (typeof j[k] === 'number' && Number.isFinite(j[k]) ? (j[k] as number) : undefined);
    return { fast: n('fastestFee'), medium: n('halfHourFee'), slow: n('hourFee') };
  } catch {
    return {};
  }
}
