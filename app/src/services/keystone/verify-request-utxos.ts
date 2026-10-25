/**
 * Checking a scanned sign request's claimed UTxOs against what we actually synced.
 *
 * **Why this exists.** A transaction body's inputs are bare outpoints — a 32-byte hash and an
 * index, nothing more. Every human-meaningful number on a review screen (which address an input
 * pays from, how much ADA, which tokens) therefore comes from *outside* the body. On our own
 * sends the wallet resolves that from its synced UTxO set. On a scanned request the counterparty
 * asserts it, in the `cardano-utxo` entries.
 *
 * So a malicious request can carry a body that spends a large UTxO while declaring a small one,
 * and a review screen that simply renders what it was handed will faithfully display the lie.
 * That is the attack this module exists to stop, and the reason it is a mapping step rather than
 * a warning banner: the screen must never be able to show an unverified number as though it were
 * ours.
 *
 * Three outcomes, deliberately distinct:
 *
 * - **verified** — the outpoint is in our synced set and every claim matches. Render normally.
 * - **mismatched** — the outpoint is ours but a claim differs. **Refuse the request.** A stale
 *   cache does not produce this: a spent UTxO disappears, it does not change its address or
 *   value. A disagreement means someone is describing our own coin incorrectly.
 * - **unknown** — not in our synced set. Renderable, but never as a plain number beside verified
 *   ones. Legitimate for a co-signer's input or an unsynced account.
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {CoreError} from '@pnyx/cardano-core/Op'
import type {ResolvedInput} from '@pnyx/tx-review'
import type {CardanoUtxo} from '@pnyx/ur'
import {Effect} from 'effect'
import {utxoAddressBech32, utxoAssetMap, utxoTxHashHex} from '../cardano/utxo-view'

/** How much of a claimed UTxO we were able to confirm ourselves. */
export type UtxoTrust =
  | {readonly kind: 'verified'}
  | {readonly kind: 'mismatched'; readonly field: 'address' | 'amount'; readonly claimed: string; readonly ours: string}
  | {readonly kind: 'unknown'}

/**
 * A review input with everything this module can establish — which is everything but the address
 * in raw hex.
 *
 * ⚠️ **`addressHex` is deliberately absent rather than defaulted.** Decoding bech32 needs the codec
 * and this module is synchronous, so it has no way to produce the field. Filling it with `''` is
 * what shipped, and it does not fail loudly: `Address.inspect('')` returns a base address with
 * *empty credentials*, so `classifyCreds` matched nothing and every input in an air-gap review —
 * the wallet's own verified ones included — was classified as not ours. `signing-paths.ts` inspects
 * the same field. {@link resolveInputAddresses} is the other half.
 *
 * `addressBech32` is required here, unlike on {@link ResolvedInput}, so that completion is total
 * and cannot rediscover the same hole from the other side.
 */
export type CheckedInputValues = Omit<ResolvedInput, 'addressHex'> & {readonly addressBech32: string}

export type CheckedInput = {
  readonly resolved: CheckedInputValues
  readonly trust: UtxoTrust
  /** The BIP-32 path the request says signs this input. */
  readonly keyPathComponents: readonly {readonly index: number; readonly hardened: boolean}[]
}

export type RequestUtxoCheck =
  /** Every claimed UTxO is either ours-and-matching or genuinely unknown. Safe to review. */
  | {readonly kind: 'reviewable'; readonly inputs: readonly CheckedInput[]; readonly unknownCount: number}
  /**
   * At least one claim contradicts our own state. The request is refused outright rather than
   * shown with a warning — we know it is wrong, and a user cannot meaningfully overrule that.
   */
  | {readonly kind: 'refused'; readonly reason: string; readonly offending: readonly CheckedInput[]}

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** `txHash:index`, the key both sides agree on. */
const outpointKey = (txHashHex: string, index: number): string => `${txHashHex}:${index}`

/**
 * Index our synced UTxOs by outpoint.
 *
 * Exported because the caller usually holds the wallet's UTxO list already and building this once
 * per review beats rebuilding it per input.
 */
export const indexUtxosByOutpoint = (utxos: readonly UTxO.UTxO[]): ReadonlyMap<string, UTxO.UTxO> => {
  const map = new Map<string, UTxO.UTxO>()
  for (const utxo of utxos) map.set(outpointKey(utxoTxHashHex(utxo), Number(utxo.index)), utxo)
  return map
}

const trustFor = (claimed: CardanoUtxo, ours: UTxO.UTxO | undefined): UtxoTrust => {
  if (ours === undefined) return {kind: 'unknown'}
  if (claimed.address !== utxoAddressBech32(ours)) {
    return {kind: 'mismatched', field: 'address', claimed: claimed.address, ours: utxoAddressBech32(ours)}
  }
  // `amount` is text on the wire precisely because lovelace can exceed 2^53; compare as bigint so
  // a large value cannot collide with a nearby one through float rounding.
  const claimedLovelace = BigInt(claimed.amount)
  if (claimedLovelace !== ours.assets.lovelace) {
    return {
      kind: 'mismatched',
      field: 'amount',
      claimed: claimed.amount,
      ours: ours.assets.lovelace.toString(),
    }
  }
  return {kind: 'verified'}
}

/**
 * Build the review's resolved inputs from a request, refusing outright if any claim contradicts
 * our synced state.
 *
 * For a verified input the rendered address and value are read from **our** record rather than the
 * request's. Today that is indistinguishable — `verified` means the two are byte-equal — so it is
 * defence against a future edit, not an active check: if the comparison is ever loosened (a
 * case-insensitive address match, an amount tolerance), reading ours is what keeps the loosened
 * form off the screen. Do not "simplify" it to use the claim.
 */
export const checkRequestUtxos = (
  claimedUtxos: readonly CardanoUtxo[],
  syncedByOutpoint: ReadonlyMap<string, UTxO.UTxO>,
): RequestUtxoCheck => {
  const inputs: CheckedInput[] = claimedUtxos.map((claimed) => {
    const txHashHex = toHex(claimed.transactionHash)
    const ours = syncedByOutpoint.get(outpointKey(txHashHex, claimed.index))
    const trust = trustFor(claimed, ours)
    const verified = trust.kind === 'verified' && ours !== undefined

    const resolved: CheckedInputValues = {
      txHashHex,
      index: claimed.index,
      // For a verified input every rendered value is ours. For an unknown one we have nothing
      // else, so the claim is carried — and `trust` is what stops the screen presenting it as
      // established.
      addressBech32: verified ? utxoAddressBech32(ours) : claimed.address,
      coin: verified ? ours.assets.lovelace : BigInt(claimed.amount),
      tokens: verified ? tokensOf(ours) : [],
    }
    return {resolved, trust, keyPathComponents: claimed.keyPath.components}
  })

  const offending = inputs.filter((input) => input.trust.kind === 'mismatched')
  if (offending.length > 0) {
    const [first] = offending
    const detail =
      first !== undefined && first.trust.kind === 'mismatched'
        ? `input ${first.resolved.txHashHex.slice(0, 8)}…#${first.resolved.index} claims ${first.trust.field} ${first.trust.claimed}, ours is ${first.trust.ours}`
        : 'a claimed input contradicts our own record'
    return {kind: 'refused', reason: detail, offending}
  }

  return {
    kind: 'reviewable',
    inputs,
    unknownCount: inputs.filter((input) => input.trust.kind === 'unknown').length,
  }
}

/**
 * Complete the checked inputs into reviewable ones by decoding each address to raw bytes.
 *
 * The one effectful export here, and it lives beside the gap it fills rather than in the screen:
 * `addressHex` is what the review classifies ownership by, so leaving the conversion to a caller is
 * what let an empty string stand in for it unnoticed.
 *
 * An address that will not decode **fails the whole batch**. There is no per-input fallback worth
 * having: a review that quietly renders one input as nobody's coin is the same class of lie this
 * module exists to prevent.
 */
export const resolveInputAddresses = (
  inputs: readonly CheckedInput[],
): Effect.Effect<readonly ResolvedInput[], CoreError> =>
  Effect.forEach(inputs, (input) =>
    // ⚠️ `Effect.try`, not the argument position: the bech32 comes from a hardware request, so a
    // malformed one is a thing that happens. Built as an argument it would throw past this
    // pipeline instead of failing it, and the caller's whole point is that one bad address
    // fails the BATCH rather than degrading a single input into nobody's coin.
    Effect.try({
      try: () => Bech32(input.resolved.addressBech32),
      catch: (cause) => new CoreError({op: 'addressFromBech32', message: String(cause)}),
    }).pipe(
      Effect.flatMap((bech32) => Address.fromBech32(bech32)),
      Effect.map((addressHex): ResolvedInput => ({...input.resolved, addressHex})),
    ),
  )

const tokensOf = (utxo: UTxO.UTxO): ResolvedInput['tokens'] =>
  Array.from(utxoAssetMap(utxo), ([unit, amount]) => {
    // ⚠️ Split on the DOT, not at offset 56. `utxoAssetMap` emits `policy.name`, so slicing by
    // position left the separator on the front of the asset name — `.4d494c4b` instead of
    // `4d494c4b` — and an air-gap review would then show and compare the wrong name. It passed
    // only because the test fixture used the JOINED spelling, which nothing in production emits.
    const [policyIdHex = '', assetNameHex = ''] = unit.split('.')
    return {
      policyIdHex,
      assetNameHex,
      amount,
    }
  })
