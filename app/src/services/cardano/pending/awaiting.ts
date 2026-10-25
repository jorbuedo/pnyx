/**
 * Whose signature a pending transaction is actually waiting on, among the wallets on this
 * device.
 *
 * The stored `groupId` cannot answer this. It records who *filed* the envelope — the
 * composer for a co-funded send, whichever wallet happened to be selected for an import —
 * and a co-signed transaction is waiting on several wallets by construction. Reading the
 * filing group as the answer is what let the co-sign screen say "switch to ‹wallet›" and
 * send someone to a wallet with no route to the transaction.
 *
 * So it is derived from the roster, which is the thing that actually names the signers:
 *
 * - **multiparty** rows carry the party's payment key hash, which matches an ordinary
 *   wallet's own key hashes. Answerable here, from the envelope alone.
 * - **multisig** rows carry CIP-1854 co-signer key hashes, which no ordinary wallet holds.
 *   Answering those needs the `SharedWallet` record and its cached account xpubs
 *   (`localCoSignersOf`), so this reports `unknown` for them rather than guessing — a
 *   multisig envelope is filed under the shared wallet itself, which every co-signer has,
 *   so its group *is* the right answer and nothing needs deriving.
 *
 * @module
 */

import {requiredFor, statusOf} from '../cosign/envelope'
import type {TxEnvelope} from '../cosign/types'
import {type LocalWallet, localMultipartySignersOf} from '../multiparty/local-signers'

export type AwaitingHere =
  /**
   * Every signature is in — this is waiting to be *broadcast*, not signed.
   *
   * Checked before anything about who holds which key, because "all of my rows are signed"
   * is true both of a transaction still waiting on somebody else and of one that is
   * complete, and calling the second "waiting for the other signers" tells the one person
   * who can finish it to go and wait.
   */
  | {readonly kind: 'ready'}
  /** This device holds a key for a row that is still unsigned, and can produce it. */
  | {readonly kind: 'you'; readonly wallets: readonly {readonly groupId: string; readonly name: string}[]}
  /** Rows this device matches are all signed — it has given everything it can. */
  | {readonly kind: 'others'}
  /**
   * Not derivable from the envelope: a multisig roster, or a wallet set that names nobody
   * here. Distinct from `others` on purpose — "someone else is signing" and "we cannot tell"
   * are different sentences, and rendering the second as the first is a guess.
   */
  | {readonly kind: 'unknown'}

/**
 * Which of this device's wallets still owe a signature to `envelope`.
 *
 * Read-only wallets never appear: they match a roster row by key hash and can never satisfy
 * it, which `localMultipartySignersOf` already enforces through `canSign`.
 */
export const awaitingHere = (envelope: TxEnvelope, wallets: readonly LocalWallet[]): AwaitingHere => {
  // Ahead of the roster match, and ahead of the multiparty check: a gathered multisig
  // transaction is equally ready, and equally misdescribed by silence.
  if (statusOf(envelope, requiredFor(envelope)).meetsQuorum) return {kind: 'ready'}
  if (envelope.kind !== 'multiparty') return {kind: 'unknown'}
  const mine = localMultipartySignersOf(envelope.signers, wallets)
  if (mine.length === 0) return {kind: 'unknown'}
  const owed = mine.filter((signer) => !signer.signed)
  if (owed.length === 0) return {kind: 'others'}
  // One entry per wallet, not per owed witness: a party spending from two of its own
  // addresses owes two signatures and is still one wallet to go and open.
  const seen = new Set<string>()
  const walletsOwed: {groupId: string; name: string}[] = []
  for (const signer of owed) {
    if (seen.has(signer.groupId)) continue
    seen.add(signer.groupId)
    walletsOwed.push({groupId: signer.groupId, name: signer.walletName})
  }
  return {kind: 'you', wallets: walletsOwed}
}
