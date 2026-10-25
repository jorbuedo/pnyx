/**
 * Multiparty (multi-input-wallet co-funding) support. Distinct from multisig: a
 * multiparty tx spends UTxOs from several ordinary wallets, so its required
 * signers are one per contributing wallet (each signs with its own payment
 * key). The shared review/co-sign machinery (envelope + quorum panel) is reused;
 * this module just identifies which wallets must sign a built body.
 *
 * @module
 */

import {Address} from '@pnyx/cardano-core'
import type {EnvelopeSigner} from '../cosign/types'

/** A wallet that can contribute inputs, with the payment key hashes it controls. */
export type ContributingWallet = {
  readonly walletId: string
  readonly name: string
  /** blake2b-224 payment key hashes across the wallet's addresses. */
  readonly paymentKeyHashes: readonly string[]
  readonly isSelf?: boolean
}

/** A resolved input whose address we know (from a contributing wallet's UTxO set). */
export type ResolvedInputAddress = {readonly addressHex: string}

/**
 * Required signers for a multiparty body: **one row per key the body actually spends
 * from**, attributed to the wallet that holds it.
 *
 * One row per *wallet* was the earlier shape, carrying whichever of its key hashes matched
 * first, and it under-counted the ledger's requirement. A party's selected coins can sit on
 * two of their own addresses — ordinary for a gap-scanned wallet — and each address's key
 * owes its own vkey witness. The fee already knew this (`distinctSignersOf` counts distinct
 * key hashes); the roster did not, so it displayed "1 of 1" for a party owing two
 * signatures, and `meetsQuorum` — which counts signed rows — agreed.
 *
 * It did not break a submit, because a wallet signing resolves every input it owns in one
 * pass and returns both witnesses. It read wrong, and it would have gone wrong the moment a
 * party signed on a device holding only one of the two keys.
 *
 * `rosterByCoSigner` already groups rows by `id` and sums `owed`, so the panel says "1 of 2"
 * for that party without further work.
 *
 * Pure — inspects each resolved input's address payment credential and matches it to a
 * wallet.
 */
export const extractRequiredSigners = (
  resolvedInputs: readonly ResolvedInputAddress[],
  wallets: readonly ContributingWallet[],
): readonly EnvelopeSigner[] => {
  const usedKeyHashes = new Set<string>()
  for (const input of resolvedInputs) {
    const info = Address.inspect(input.addressHex)
    if (info.paymentCredHex !== undefined && info.paymentIsScript !== true) {
      usedKeyHashes.add(info.paymentCredHex.toLowerCase())
    }
  }
  const signers: EnvelopeSigner[] = []
  const claimed = new Set<string>()
  for (const wallet of wallets) {
    for (const hash of wallet.paymentKeyHashes) {
      const normalised = hash.toLowerCase()
      // A key hash two wallets both claim is one key imported twice; it owes one witness,
      // and attributing it to both would demand a second signature nobody can add.
      if (!usedKeyHashes.has(normalised) || claimed.has(normalised)) continue
      claimed.add(normalised)
      signers.push({
        id: wallet.walletId,
        name: wallet.name,
        keyHashHex: hash,
        signed: false,
        ...(wallet.isSelf ? {isSelf: true} : {}),
      })
    }
  }
  return signers
}
