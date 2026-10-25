/**
 * Resolving Pnyx identity rows (`docs/PNYX_IDENTITY_PLAN.md`).
 *
 * Resolution only — publishing lives in {@link module:./identity-publish}, which owns the proving
 * artifacts and the sponsored `/register` relay. Reads need none of that.
 *
 * **Read straight from an indexer, not through our service.** This used to be
 * `GET /identities/:C` on the content service, which meant the service learned *who looked up
 * whom* — a social graph an app built on unlinkability has no business handing anyone. The app now
 * fetches the contract's state itself and decodes the row locally, so a lookup is invisible: there
 * is no read-one-key query on Midnight, so the whole ledger comes down and the indexer cannot tell
 * which row was wanted either.
 *
 * The decode is native (`identityRowFromState`) because Hermes has no WASM to run the generated
 * ledger decoder. Only the *contract address* still comes from `/auth/config` — deployment
 * configuration, fetched once, revealing nothing about any particular lookup.
 *
 * **Resolving needs no verification.** The circuit authenticated the write, so whatever sits at row
 * `C` was put there by whoever knows its preimage. There is no signature to check and no junk to
 * filter — which is exactly what the `mn_addr`-keyed keybook this replaced needed a reader-side pass
 * for, since the contract could not check the binding it depended on.
 *
 * @module
 */

import {type CardRowBytes, type DecodedCard, decodeCard} from '@pnyx/contract-client/card'
import {decodePnyxId} from '@pnyx/contract-client/identity'
import {hex} from '@pnyx/crypto'
import {identityRowFromState} from '@pnyx/midnight-native'
import {logger} from '../logger'
import {identityContractAddressFor} from './identity-contract'
import {readPnyxContractState, resetPnyxContractStateCache} from './pnyx-contract-state'

const ORIGIN = 'identity-row'

/** A row as published on chain. `name` is all-zero when no `.night` claim is made. */
export type IdentityRow = {
  readonly anchor: Uint8Array
  readonly authPub: Uint8Array
  readonly name: Uint8Array
  /**
   * The contact card, decoded.
   *
   * ⚠️ **`defects` is part of the answer, not an error channel.** A card that failed to parse and a
   * card with nothing on it are different facts, and a screen rendering the same nothing for both makes
   * the second undiagnosable — so the decoder reports both and callers log the defects.
   *
   * The rows come out of the native read (`identityRowFromState`) and are decoded here rather than in
   * the caller: `decodeCard` owns the wire format, and two decoders is how they start disagreeing.
   */
  readonly card: DecodedCard
  /**
   * The card's rows exactly as the chain holds them.
   *
   * Kept beside the decoded form because a save is a **diff**: `cardWritePlan` compares the encoded
   * target against these bytes to decide which slots to write, and re-encoding `card.entries` to
   * recover them would make the comparison circular — an entry the decoder dropped as a defect would
   * come back as "changed" and be overwritten.
   */
  readonly cardRows: readonly CardRowBytes[]
}

/**
 * Why a lookup produced no row. `unpublished` is a definite answer — that identity exists but has
 * never enabled messaging — while `unavailable` means we could not find out, and the two must not
 * be shown the same way.
 */
export type IdentityLookup =
  | {readonly kind: 'row'; readonly row: IdentityRow}
  | {readonly kind: 'unpublished'}
  | {readonly kind: 'unavailable'}

/**
 * Resolve one identity to its row.
 *
 * Takes a bech32m `pnyx_id`, so a malformed or wrong-network value throws here rather than
 * silently becoming a lookup that reports the *other* person as unpublished.
 */
export const resolveIdentityRow = async (pnyxId: string): Promise<IdentityLookup> => {
  const {identity} = decodePnyxId(pnyxId)
  try {
    // Derived from `C`, never configured and never accepted from a caller: the honest contract for an
    // identity is the one its own commitment addresses, and the decoder refuses a state sealed to
    // anything else. That pairing is what makes a lookup safe without a registry.
    const address = hex.encode(await identityContractAddressFor(identity))
    const state = await readPnyxContractState(address)
    if (state === null) {
      // ⚠️ Two facts arrive here as one `null`, and this branch used to take its exit in silence.
      // "The indexer did not answer" and "no contract has ever been deployed at this address" — the
      // second being every id that has never registered — both surface to the user as "this build
      // cannot reach the chain", which blames the app for a stranger never having signed up. Telling
      // them apart needs `readPnyxContractState` to say which, so until then this at least says the
      // read produced nothing and names the address that produced it.
      logger.warn(
        'no contract state for an identity; cannot tell an unreachable indexer from an id that was never registered',
        {
          origin: ORIGIN,
          address,
        },
      )
      return {kind: 'unavailable'}
    }
    const row = await identityRowFromState(state, identity)
    if (row === undefined) return {kind: 'unpublished'}
    const card = decodeCard(row.card)
    if (card.defects.length > 0) {
      // Logged, never hidden: a row this client cannot draw is the read-side half of the card format
      // doing its job, and silence would make a partly-unreadable card look like an empty one.
      logger.warn('some card rows did not decode', {
        origin: ORIGIN,
        defects: card.defects.map((d) => `${d.slot}:${d.reason}`),
      })
    }
    return {kind: 'row', row: {anchor: row.anchor, authPub: row.authPub, name: row.name, card, cardRows: row.card}}
  } catch (error) {
    // A decode failure is "we could not look", never "they have not published": reporting the
    // latter would tell the user a reachable peer cannot be messaged.
    logger.warn('identity lookup failed', {origin: ORIGIN, error: String(error)})
    return {kind: 'unavailable'}
  }
}

/**
 * Drop the cached state — for tests and for a network switch, which changes the contract.
 *
 * Re-exported under this name because callers know it as the identity-lookup cache; the state itself
 * is now shared with the proving rail ({@link module:./pnyx-contract-state}), so clearing it here
 * clears it for both. That is the intent: a network switch invalidates every read of the old chain.
 */
export const resetIdentityRowCache = resetPnyxContractStateCache
