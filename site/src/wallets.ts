/**
 * site/src/wallets.ts — READ-ONLY account reads from injected browser wallets: addresses and public
 * keys, nothing else. This file calls no signing, sending or message method of any wallet, and nothing
 * else in the page does either (a build check greps the bundle for them).
 *
 * The core needs a public key per account because it proves every address is its key's (taproot: the
 * BIP86 tweak; subfrost-wallet-common wallet.rs check_external_account), and a taproot internal key
 * never appears on chain. The calls are the app's own (context/WalletContext.tsx connect paths):
 *   Xverse   XverseProviders.BitcoinProvider.request('getAccounts', { purposes: ['ordinals','payment'] })
 *   Leather  LeatherProvider.request('getAddresses')  → result.addresses[{ symbol, type, address, publicKey }]
 *   UniSat   unisat.requestAccounts() + unisat.getPublicKey()
 *   OKX      okxwallet.bitcoin.connect() → { address, publicKey }
 */
export interface Account {
  address: string;
  pubkey: string;
}
export interface Accounts {
  taproot?: Account;
  segwit?: Account;
  /** Which wallet answered (display). */
  from: string;
}

type AnyWin = Window & Record<string, any>;
const w = () => window as unknown as AnyWin;

const isTaproot = (a: string) => /^(bc1p|tb1p|bcrt1p)/i.test(a);
const isSegwit = (a: string) => /^(bc1q|tb1q|bcrt1q)/i.test(a);

function withTimeout<T>(p: Promise<T>, what: string, ms = 60_000): Promise<T> {
  return Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${what} did not answer`)), ms))]);
}

function place(out: Accounts, address: string | undefined, pubkey: string | undefined): void {
  if (!address || !pubkey) return;
  if (isTaproot(address) && !out.taproot) out.taproot = { address, pubkey };
  else if (isSegwit(address) && !out.segwit) out.segwit = { address, pubkey };
}

export const WALLETS: Array<{ id: string; name: string; present: () => boolean; read: () => Promise<Accounts> }> = [
  {
    id: 'xverse',
    name: 'Xverse',
    present: () => !!w().XverseProviders?.BitcoinProvider,
    async read() {
      const res: any = await withTimeout(
        w().XverseProviders.BitcoinProvider.request('getAccounts', { purposes: ['ordinals', 'payment'], message: 'Read your addresses (read-only Accelerate check)' }),
        'Xverse',
      );
      const out: Accounts = { from: 'Xverse' };
      for (const a of res?.result ?? []) place(out, a?.address, a?.publicKey);
      return out;
    },
  },
  {
    id: 'leather',
    name: 'Leather',
    present: () => !!w().LeatherProvider,
    async read() {
      const res: any = await withTimeout(w().LeatherProvider.request('getAddresses'), 'Leather');
      const out: Accounts = { from: 'Leather' };
      for (const a of res?.result?.addresses ?? []) if (a?.symbol === 'BTC') place(out, a.address, a.publicKey);
      return out;
    },
  },
  {
    id: 'unisat',
    name: 'UniSat',
    present: () => !!w().unisat,
    async read() {
      const accounts: string[] = await withTimeout(w().unisat.requestAccounts(), 'UniSat');
      const pubkey: string = await withTimeout(w().unisat.getPublicKey(), 'UniSat');
      const out: Accounts = { from: 'UniSat' };
      place(out, accounts?.[0], pubkey);
      return out;
    },
  },
  {
    id: 'okx',
    name: 'OKX',
    present: () => !!w().okxwallet?.bitcoin,
    async read() {
      const res: any = await withTimeout(w().okxwallet.bitcoin.connect(), 'OKX');
      const out: Accounts = { from: 'OKX' };
      place(out, res?.address, res?.publicKey);
      return out;
    },
  },
];
