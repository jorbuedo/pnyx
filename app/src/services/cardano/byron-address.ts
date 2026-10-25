/**
 * Recognising a Byron-era Cardano address.
 *
 * Byron addresses are base58 CBOR, not bech32 — so handing one to a bech32
 * decoder fails, and on a real mainnet wallet it fails *often*: any counterparty
 * still on a `Ddz…` address produces one per history row, per pass. Those
 * failures were logged as decode errors, which is the wrong reading twice over:
 * nothing is broken, and the log buried the failures that would matter.
 *
 * There is no credential to extract either. A Byron address carries no stake
 * credential at all, and its payment part is a hash inside a CBOR structure this
 * app's codec does not decode from base58. So "no credentials" is the true answer
 * for one, not a degradation — the history row is own/other because that is all a
 * Byron address can tell us.
 *
 * @module
 */

/**
 * The three prefixes Byron addresses are written with: `Ddz…` (Icarus-style
 * mainnet), `Ae2…` (Daedalus-style mainnet) and `2cWKMJ…` (testnet).
 *
 * A prefix test rather than a base58 decode: this only has to separate "expected
 * shape we cannot inspect" from "something is actually wrong with this string",
 * and decoding to answer that would be work for no extra fact.
 */
const BYRON_PREFIXES = ['Ddz', 'Ae2', '2cWKMJ'] as const

/** True for an address written in the Byron base58 form. */
export const isByronAddress = (address: string): boolean => {
  const trimmed = address.trim()
  return BYRON_PREFIXES.some((prefix) => trimmed.startsWith(prefix))
}
