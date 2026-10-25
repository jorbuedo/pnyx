/**
 * Reading and saving this identity's contact card.
 *
 * The card is `identity.compact`'s `card: Map<Uint<8>, CardRow>` — 320-byte rows the contract treats as
 * opaque, whose meaning lives entirely in `@pnyx/contract-client/card`. This module is the seam between
 * that codec and the chain: it turns a list of entries into the `setRows` calls that write them, proves
 * each on this device, and relays them for the sponsor to pay.
 *
 * **Why a save can be several transactions.** `setRows` writes exactly four slots per proof — the width
 * is frozen in the template — so a card of five entries is two proofs. They are not batched into one
 * transaction either: each call carries its own proof, so several in one transaction saves nothing, and
 * the sponsor funds exactly one contract action per transaction anyway.
 *
 * ⚠️ **A save is the whole card, not a diff.** `cardWriteSet` also emits the *clears* a shrunken card
 * needs: dropping an entry moves every later row down a slot, so without them the tail of the previous
 * layout survives as orphaned rows. That is why saving needs the current row count first — and why
 * {@link saveCard} takes it rather than guessing.
 *
 * @module
 */

import {
  type CardEntry,
  type CardRowBytes,
  type CardWrite,
  cardWritePlan,
  encodeCard,
  MAX_SLOTS,
  normalizeCardEntries,
} from '@pnyx/contract-client/card'
import {hex} from '@pnyx/crypto'
import {buildSetRowProvenTx, buildSetRowsProvenTx} from '@pnyx/midnight-native'
import {logger} from '../logger'
import {ensureCircuitArtifacts} from './pnyx-artifacts'
import {readPnyxContractState} from './pnyx-contract-state'
import {relaySponsoredTx} from './sponsored-relay'

const ORIGIN = 'identity-card'

export type SaveCardInputs = {
  readonly entries: readonly CardEntry[]
  /**
   * The rows the card holds **on chain right now**.
   *
   * Not derivable from `entries`, and not a count either: it is what decides *which* slots have to be
   * written at all. A save that had only a count would have to rewrite every row.
   */
  readonly current: readonly CardRowBytes[]
  readonly identitySk: Uint8Array
  readonly contractAddress: Uint8Array
  readonly networkId: string
  /** Absolute unix-second expiry — a duration writes Timestamp(3600) and the node rejects it. */
  readonly expiresAtSecs: number
}

/** Why a save did not reach the chain. */
export type CardSaveFailure =
  /** More entries than the contract's slot bound allows. Refused before any proving cost. */
  | {readonly kind: 'too-large'; readonly slots: number}
  /** The identity contract's state could not be read, so nothing was proved against it. */
  | {readonly kind: 'unreadable'}
  /** Proving failed on device. `batch` is which one, since a save can be several. */
  | {readonly kind: 'proof'; readonly batch: number}
  /** The relay refused or could not be reached. */
  | {readonly kind: 'relay'; readonly batch: number; readonly detail: string}

export type CardSaveResult =
  | {readonly ok: true; readonly batches: number}
  | {readonly ok: false; readonly failure: CardSaveFailure}

/**
 * Write `entries` as this identity's card.
 *
 * ⚠️ **Not atomic across batches**, and it cannot be: each `setRows` is its own transaction. A failure
 * partway leaves the card in a mixed state — the earlier batches applied, the rest not — which is why
 * the failure names *which* batch, and why a retry re-sends the whole write set rather than resuming.
 * Re-sending is safe: a write set is a statement of what the card should be, not a delta.
 *
 * ⚠️ Every batch is proved against the state read **once**, at the start. `setRows` does not read the
 * slots it writes (that is the point of a batch stating what the card should be), so a later batch does
 * not depend on an earlier one having landed — but a *concurrent* edit from another device would be
 * overwritten rather than merged. One card, one owner, so that is the intended resolution.
 */
export const saveCard = async (inputs: SaveCardInputs): Promise<CardSaveResult> => {
  // Normalised here, not only at the form: this is the last place before the bytes are fixed, and a
  // caller that skipped it would rewrite rows nobody edited (`normalizeCardEntries` explains why).
  const entries = normalizeCardEntries(inputs.entries)
  const rows = encodeCard(entries)
  if (rows.length > MAX_SLOTS) {
    logger.warn('card save refused: too many slots', {origin: ORIGIN, slots: rows.length, max: MAX_SLOTS})
    return {ok: false, failure: {kind: 'too-large', slots: rows.length}}
  }
  const plan = cardWritePlan(inputs.current, entries)
  if (plan.length === 0) {
    // Nothing to prove. Reported as success because the card *is* what was asked for — a "failure"
    // here would make an idle Save look broken.
    logger.debug('card save is a no-op: nothing changed', {origin: ORIGIN, entries: entries.length})
    return {ok: true, batches: 0}
  }

  const addressHex = hex.encode(inputs.contractAddress)
  const state = await readPnyxContractState(addressHex)
  if (state === null) {
    logger.warn('card save refused: the identity contract could not be read', {origin: ORIGIN, address: addressHex})
    return {ok: false, failure: {kind: 'unreadable'}}
  }

  logger.info('saving the contact card', {
    origin: ORIGIN,
    entries: entries.length,
    rows: rows.length,
    held: inputs.current.length,
    transactions: plan.length,
    // Which circuits, because they cost differently: `setRow` is K13, `setRows` K14.
    shape: plan.map((write) => write.op).join(','),
  })

  for (const [index, write] of plan.entries()) {
    let tx: Uint8Array
    const startedAt = Date.now()
    try {
      tx = await buildWrite({write, state, inputs})
    } catch (error) {
      logger.warn('a card write could not be proved', {origin: ORIGIN, batch: index, error: String(error)})
      return {ok: false, failure: {kind: 'proof', batch: index}}
    }
    logger.info('card write proved on device', {
      origin: ORIGIN,
      batch: index,
      of: plan.length,
      op: write.op,
      ms: Date.now() - startedAt,
      bytes: tx.length,
      slots: write.op === 'row' ? [write.row.slot] : write.rows.map((r) => r.slot),
    })
    try {
      await relaySponsoredTx(tx)
    } catch (error) {
      return {
        ok: false,
        failure: {kind: 'relay', batch: index, detail: error instanceof Error ? error.message : String(error)},
      }
    }
  }
  logger.info('the contact card is saved', {origin: ORIGIN, transactions: plan.length})
  return {ok: true, batches: plan.length}
}

/**
 * One write, on whichever circuit fits it.
 *
 * `setRow` is **K13/6,999** against `setRows`' K14/12,818, so a single-slot edit costs about half the
 * proving. The plan decides which; this only builds what it was handed.
 */
const buildWrite = async (params: {
  readonly write: CardWrite
  readonly state: Uint8Array
  readonly inputs: SaveCardInputs
}): Promise<Uint8Array> => {
  const {write, state, inputs} = params
  const common = {
    contractState: state,
    contractAddress: inputs.contractAddress,
    identitySk: inputs.identitySk,
    networkId: inputs.networkId,
    ttlSecs: inputs.expiresAtSecs,
  }
  if (write.op === 'row') {
    return buildSetRowProvenTx({
      ...common,
      artifacts: await ensureCircuitArtifacts('setRow', 'identity'),
      slot: write.row.slot,
      kind: write.row.kind,
      value: write.row.value,
    })
  }
  return buildSetRowsProvenTx({
    ...common,
    artifacts: await ensureCircuitArtifacts('setRows', 'identity'),
    rows: [...write.rows],
  })
}
