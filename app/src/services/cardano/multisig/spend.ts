/**
 * What a shared-wallet spend needs beyond an ordinary one: the validity interval
 * its template demands, the envelope's signer roster, and whether a set of
 * collected signatures satisfies the template structurally.
 *
 * The *building* of a shared spend is not here. It goes through the ordinary send
 * builder (`send-flow.ts`), which inherits coin selection, the fee pass, the size
 * check and the review IR — everything a second builder would have to reimplement
 * and then keep in step. A parallel `planSpend`/`buildSharedSpendBody`/
 * `envelopeForSpend` trio did live here, reachable only from its own tests; it was
 * removed rather than carried into multi-index signing, where it would have been a
 * second implementation of the same rule with nothing exercising it.
 *
 * @module
 */

import type {EnvelopeSigner} from '../cosign/types'
import {quorumStatusOf} from './model'
import {validityBounds} from './template'
import type {SharedWallet} from './types'

/**
 * The validity interval a spend must carry.
 *
 * A time-locked script only validates inside its bounds, and the ledger checks
 * the *transaction's* interval against them — so a transaction that omits the
 * interval fails phase-1 no matter when it is submitted. `null` on a side means
 * the template does not constrain it.
 */
export const validityFor = (
  wallet: Pick<SharedWallet, 'paymentTemplate'>,
): {readonly invalidBefore: bigint | null; readonly invalidHereafter: bigint | null} => {
  const {from, until} = validityBounds(wallet.paymentTemplate)
  return {invalidBefore: from, invalidHereafter: until}
}

/**
 * The envelope's signer roster at one payment index: one row per co-signer, none
 * signed yet.
 *
 * `scriptIndex` says which of the envelope's scripts these rows belong to, so a
 * spend touching several indexes produces a roster per index and the quorum can be
 * judged where the ledger judges it — per script. `keyHashByTag` must have been
 * derived at that same index; the key hashes are what tie a witness back to a row,
 * and a co-signer's key differs at every index.
 */
export const signersFor = (
  wallet: SharedWallet,
  keyHashByTag: ReadonlyMap<string, string>,
  scriptIndex = 0,
): readonly EnvelopeSigner[] =>
  wallet.coSigners.map((c) => ({
    id: c.tag,
    name: c.name,
    // A tag with no derived hash would be a signer nobody can ever satisfy;
    // `paymentKeyHashes` covers the whole roster, so this cannot be reached
    // through the intended path.
    keyHashHex: keyHashByTag.get(c.tag) ?? '',
    signed: false,
    ...(scriptIndex === 0 ? {} : {scriptIndex}),
    ...(c.isSelf ? {isSelf: true} : {}),
  }))

/**
 * Whether an envelope's collected signatures satisfy the wallet's template.
 *
 * Goes through the template *structurally*, so under a nested policy the right
 * two signatures satisfy it and the wrong two do not — a distinction no count can
 * draw. `all [A, any [B, C]]` needs two signatures either way, but B+C is not one
 * of the pairs that works.
 *
 * ⚠️ **Not the live gate.** The co-sign screen counts signatures against what the
 * compiled script requires (`requiredFor`), because that is what a co-signer
 * holding nothing but an envelope can compute — no roster, no template. The two
 * agree for every wallet this app can create: the roster editor only ever builds
 * flat templates (`all` / `any` / `at_least n` over co-signer leaves, optionally
 * time-locked), and for those, counting *is* the structural answer. This is the
 * ready answer for the day a nested template can be built or imported, and the
 * reason it was kept rather than deleted with the builders above.
 */
export const envelopeMeetsPolicy = (
  wallet: SharedWallet,
  envelope: {readonly signers: readonly EnvelopeSigner[]},
): boolean =>
  quorumStatusOf(
    wallet,
    envelope.signers.filter((s) => s.signed).map((s) => s.id),
  ).meetsQuorum
