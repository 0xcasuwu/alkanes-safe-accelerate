/**
 * site/src/polyfill.ts — imported FIRST by main.ts: the app code it bundles uses Node's Buffer, and
 * bitcoinjs-lib needs an ECC library for taproot address scripts (the app's own @bitcoinerlab/secp256k1).
 */
import { Buffer } from 'buffer';
import * as bitcoin from 'bitcoinjs-lib';
import * as ecc from '@bitcoinerlab/secp256k1';

(globalThis as unknown as { Buffer: typeof Buffer }).Buffer = Buffer;
bitcoin.initEccLib(ecc);
