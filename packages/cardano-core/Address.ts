// Address helpers — bech32 round-trip + payment-key-hash via the core, plus pure
// Shelley header-byte construction from credential hashes. (No crypto here; the
// key hashing lives in the core. Richer typed address model comes in A5.)

import {AddressEras, Address as EvAddress} from '@evolution-sdk/evolution'
import {AddressHex, Bech32 as asBech32, type Bech32, KeyHashHex} from '@evolution-sdk/review/Brands'
import {bytesToHex, hexToBytes} from '@noble/hashes/utils.js'
import {op} from './Op.js'

/** A Shelley credential is blake2b-224 — 28 bytes (CIP-19). */
const CRED_BYTES = 28

export enum Network {
  Mainnet = 1,
  Testnet = 0,
}

// Shelley address header = (type << 4) | networkId.
// type 0 = base (paykey+stakekey), 6 = enterprise (paykey), 14 = reward (stakekey).
const hdr = (type: number, net: Network): string => ((type << 4) | net).toString(16).padStart(2, '0')

/**
 * A credential hash is 28 bytes, and these builders CONCATENATE — so anything else produces a
 * well-formed-looking address of the wrong length, pointing at nobody or, worse, at somebody.
 *
 * Checked here because nothing downstream does: the brands are nominal, the result is a plain
 * hex string, and a CIP-113 smart-wallet address built from a truncated PLB hash reads as an
 * ordinary empty wallet. Found on 2026-10-04 by the CIP-113 port differential, where Evolution's
 * own address constructors refused every case this accepted.
 */
const cred28 = (what: string, hashHex: string): string => {
  if (!/^[0-9a-fA-F]*$/.test(hashHex))
    throw new Error(`${what} must be hex, got ${JSON.stringify(hashHex.slice(0, 16))}`)
  if (hashHex.length !== 56) throw new Error(`${what} must be 28 bytes, got ${hashHex.length / 2}`)
  return hashHex
}

/** Enterprise address bytes (hex): payment key only. */
export const enterpriseHex = (net: Network, paymentKeyHashHex: string): AddressHex =>
  AddressHex(hdr(6, net) + cred28('payment key hash', paymentKeyHashHex))
/** Base address bytes (hex): payment + stake key. */
export const baseHex = (net: Network, paymentKeyHashHex: string, stakeKeyHashHex: string): AddressHex =>
  AddressHex(hdr(0, net) + cred28('payment key hash', paymentKeyHashHex) + cred28('stake key hash', stakeKeyHashHex))
/** Reward (stake) address bytes (hex). Also the withdrawals-map key. */
export const rewardHex = (net: Network, stakeKeyHashHex: string): AddressHex =>
  AddressHex(hdr(14, net) + cred28('stake key hash', stakeKeyHashHex))
export const baseScriptHex = (net: Network, scriptHashHex: string, stakeKeyHashHex: string): AddressHex =>
  AddressHex(hdr(1, net) + cred28('script hash', scriptHashHex) + cred28('stake key hash', stakeKeyHashHex))
/** Base address with SCRIPT payment + SCRIPT stake credentials (type 3) — a full multisig wallet. */
export const baseScriptScriptHex = (
  net: Network,
  paymentScriptHashHex: string,
  stakeScriptHashHex: string,
): AddressHex =>
  AddressHex(
    hdr(3, net) + cred28('payment script hash', paymentScriptHashHex) + cred28('stake script hash', stakeScriptHashHex),
  )
/** Reward (stake) address with a SCRIPT stake credential (type 15). */
export const rewardScriptHex = (net: Network, stakeScriptHashHex: string): AddressHex =>
  AddressHex(hdr(15, net) + cred28('stake script hash', stakeScriptHashHex))

/**
 * bech32 ⇄ hex, synchronously, THROWING on a malformed value.
 *
 * ⚠️ **These are the primitives and {@link toBech32} / {@link fromBech32} wrap them**, so there is
 * one implementation and the Effect form is visibly just `Op.op` around it. Both shapes are needed
 * and the choice is not a preference:
 *
 * - a caller already inside an `Effect.try` of its own — which most are, because they turn a bad
 *   address into their OWN domain error — wants the sync form, or it ends up composing two error
 *   types for one failure;
 * - a caller composing tier operations wants the Effect form, which reports a `CoreError`;
 * - a caller in a React render path or other non-Effect position has only the sync form.
 *
 * ⚠️ A throw inside `Effect.gen` without a `try` is a DEFECT, which `catchAll` does not catch. If
 * you are in a generator and not wrapping, use the Effect form.
 */
export const toBech32Sync = (addrHex: AddressHex): Bech32 =>
  asBech32(AddressEras.toBech32(AddressEras.fromHex(addrHex)))
/** See {@link toBech32Sync}. */
export const fromBech32Sync = (bech32: Bech32): AddressHex =>
  AddressHex(AddressEras.toHex(AddressEras.fromBech32(bech32)))

export const toBech32 = (addrHex: AddressHex) => op('addressToBech32', () => toBech32Sync(addrHex))
export const fromBech32 = (bech32: Bech32) => op('addressFromBech32', () => fromBech32Sync(bech32))
/**
 * The payment credential's hash.
 *
 * ⚠️ `Address`, not `AddressEras`, and that is the check. `Address` models only the shapes that
 * HAVE a payment credential, so a reward address fails at the decode and arrives as a typed
 * `CoreError` — where reading `.paymentCredential.hash` off the wider union would have been a
 * TypeError escaping the failure channel every other tier operation reports through.
 */
export const paymentKeyHash = (addrHex: AddressHex) =>
  op('addressPaymentKeyHash', () => KeyHashHex(bytesToHex(EvAddress.fromHex(addrHex).paymentCredential.hash)))

export enum AddressKind {
  Base = 'base',
  Enterprise = 'enterprise',
  Pointer = 'pointer',
  Reward = 'reward',
  Byron = 'byron',
}

export interface AddressInfo {
  readonly networkId: number
  readonly kind: AddressKind
  readonly paymentCredHex?: string
  readonly paymentIsScript?: boolean
  readonly stakeCredHex?: string
  readonly stakeIsScript?: boolean
}

/**
 * Inspect a Shelley/Byron address (hex). Pure header-byte parsing — the type
 * nibble selects the shape; payment/stake credential script-ness comes from bits
 * 4/5 of the header (Shelley CIP-19).
 */
export function inspect(addrHex: AddressHex | string): AddressInfo {
  const bytes = hexToBytes(addrHex)
  // ⚠️ **Refuse a header that is not there, and credentials that are not there.** This used to
  // read `bytes[0] ?? 0`, so an EMPTY string inspected as a type-0 base address on network 0 —
  // and `subarray` truncates rather than failing, so its two credentials came back as empty
  // strings. A caller comparing a key hash against `''` is comparing against a fact nobody
  // asserted. Every shape below states the length its claim requires.
  const header = bytes[0]
  if (header === undefined) throw new Error('address: empty')
  const type = header >> 4
  const networkId = header & 0x0f
  const hex = (start: number) => {
    if (bytes.length < start + CRED_BYTES) {
      throw new Error(`address: type ${type} needs ${start + CRED_BYTES} bytes, got ${bytes.length}`)
    }
    return bytesToHex(bytes.subarray(start, start + CRED_BYTES))
  }
  // Shelley type nibble: 0-3 base, 4-5 pointer, 6-7 enterprise, 14-15 reward; 8 = Byron.
  if (type <= 3) {
    return {
      networkId,
      kind: AddressKind.Base,
      paymentCredHex: hex(1),
      paymentIsScript: (type & 0b01) !== 0,
      stakeCredHex: hex(29),
      stakeIsScript: (type & 0b10) !== 0,
    }
  }
  if (type === 4 || type === 5) {
    return {networkId, kind: AddressKind.Pointer, paymentCredHex: hex(1), paymentIsScript: type === 5}
  }
  if (type === 6 || type === 7) {
    return {networkId, kind: AddressKind.Enterprise, paymentCredHex: hex(1), paymentIsScript: type === 7}
  }
  if (type === 14 || type === 15) {
    return {networkId, kind: AddressKind.Reward, stakeCredHex: hex(1), stakeIsScript: type === 15}
  }
  return {networkId, kind: AddressKind.Byron}
}
