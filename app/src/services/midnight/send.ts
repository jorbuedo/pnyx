/**
 * Sending on Midnight — build, sign, hand to the sponsor.
 *
 * Two rails behind one contract, because a send screen should not care which:
 *
 * - **Unshielded** (`mn_addr…`): the native builder signs a transfer with the role-0 Night key. No
 *   circuit, so no prover key, no SRS, nothing to download — milliseconds.
 * - **Shielded** (`mn_shield-addr…`): the native Zswap builder proves three protocol circuits, which
 *   is ~40 s of CPU and needs ~19 MB of artifacts cached first. That is why {@link MidnightSendRail}
 *   is visible to callers at all: the wait is a UI state, not an implementation detail.
 *
 * Neither pays its own fee. Midnight fees are DUST, the phone has none (a dust sync is >1.2M events),
 * and the transaction is left **unbound** so the service can merge a fee it did not author into it.
 * That is what `submitSponsoredTransfer` posts.
 *
 * Selection is naive on purpose: every UTxO of the token, largest first, until the amount is covered.
 * Midnight has no transaction-size pressure the way Cardano does — there is no queue and no
 * consolidation here — so the cheapest correct rule is the right one until something says otherwise.
 *
 * @module
 */

import {hex} from '@pnyx/crypto'
import {
  provenTxIdentifiers,
  type UnshieldedSpend,
  type WalletStateBytes,
  walletBuildTransfer,
  walletBuildUnshieldedTransfer,
} from '@pnyx/midnight-native'
import {logger} from '../../logger'
import {ensureZswapArtifacts} from '../pnyx-artifacts'
import {submitSponsoredTransfer} from '../pnyx-proving'
import {MidnightBuildError} from './build-failure'
import {runMidnight} from './effect-boundary'
import {selectUnshieldedInputs} from './input-selection'
import {DEFAULT_NIGHT_SPREAD, planChangeSplit} from './night-spread'
import {addUnshieldedLock, unshieldedUtxoId} from './wallet/unshielded-pending-store'
import {NIGHT_TOKEN_TYPE, type UnshieldedUtxo} from './wallet/unshielded-utxo-set'

export {selectUnshieldedInputs} from './input-selection'

const ORIGIN = 'midnight-send'

/** An hour. Far-future TTLs are rejected at submission as `1010: Custom error: 182`, naming nothing. */
const TTL_SECONDS = 3600

export type MidnightSendRail = 'unshielded' | 'shielded'

/**
 * A transfer that has been built and signed but not handed to anyone.
 *
 * `identifiers` are read here rather than by the caller because a device-built transaction has no
 * hash — they are the only handle it will ever have, and they must be read before the bytes leave.
 */
export type MidnightBuiltTransfer = {
  readonly transaction: Uint8Array
  readonly identifiers: readonly string[]
  /**
   * `intentHash:outputIndex` of the unshielded inputs this transfer spends.
   *
   * Carried from the build so the submit can lock them — selection happens here and nowhere else knows
   * what it chose. Empty for the shielded rail, which spends no unshielded output.
   */
  readonly consumedUtxoIds: readonly string[]
  /** Shielded only: the state with these coins marked pending. Persist it. */
  readonly state?: WalletStateBytes
}

export type MidnightSendResult = {
  /** Bytes handed to the service. Kept so a caller can report the size it submitted. */
  readonly size: number
  /**
   * The wallet state with this transfer's coins marked pending — **shielded only**, and it must be
   * persisted. Keeping the old state would let the next transfer select the same notes, and the
   * ledger rejects the pair.
   */
  readonly state?: WalletStateBytes
  /**
   * The transaction's identifiers — what a caller records so this send can be recognised on chain.
   *
   * Empty when they could not be read, which is logged as an error rather than shrugged at: the send
   * still happened, but nothing will ever be able to match it to a row. It is deliberately not fatal —
   * refusing to send because we could not prepare to *track* the send would be the worse trade.
   */
  readonly identifiers: readonly string[]
}

/**
 * Read the identifiers off a built transaction, never failing the send.
 *
 * The device has no hash for an unbound transaction, so these are the only handle — but a send that
 * went out untracked is still a send, and throwing here would lose money-in-flight to a bookkeeping
 * problem. Logged at `error` because an untrackable send is a real defect, not an expected absence.
 */
const identifiersOf = async (transaction: Uint8Array): Promise<readonly string[]> => {
  try {
    return await provenTxIdentifiers(transaction)
  } catch (error) {
    logger.error('could not read a transfer’s identifiers; this send will not be trackable', {
      origin: ORIGIN,
      bytes: transaction.length,
      error: String(error),
    })
    return []
  }
}

const toSpend = (utxo: UnshieldedUtxo): UnshieldedSpend => ({
  value: utxo.value,
  tokenType: decodeHex(utxo.tokenType, 'token type'),
  intentHash: decodeHex(utxo.intentHash, 'intent hash'),
  outputIndex: utxo.outputIndex,
})

/** Indexer hex, or a named failure. Never a zero-filled fallback: that would spend the wrong output. */
const decodeHex = (text: string, what: string): Uint8Array => {
  const decoded = hex.decode(text)
  if (decoded._tag === 'Left') {
    throw new MidnightBuildError({cause: 'malformed-input', reason: `${what} is not hex: ${text}`})
  }
  return decoded.right
}

/**
 * Build, sign and submit an unshielded transfer.
 *
 * Throws when the inputs cannot cover the amount, when the native builder refuses (a mixed token, a
 * duplicate output — see `@pnyx/midnight-native`), or when the service declines to sponsor it. Every
 * one of those is a different fact and none of them is a silent no-op.
 */
/**
 * Hand a built transfer to the sponsor and report what went out.
 *
 * The counterpart of the two builders: they sign, this submits. Split because the dApp connector's
 * `makeTransfer` builds without submitting and its `submitTransaction` submits without building, while
 * the send screen does both — one funnel, two halves, rather than a second copy of either.
 */
export const submitBuiltTransfer = async (
  token: string,
  built: MidnightBuiltTransfer,
  /**
   * Which Midnight network these bytes are for — the **funds** axis, from the in-app selector.
   *
   * The sponsor host holds one wallet per network and cannot infer this: a transfer built on preview and
   * handed to the preprod sponsor is accepted and then refused inside `balanceTx`, long after the caller
   * was told it went (`services/pnyx-proving.ts`).
   */
  networkId: string,
  /** Locking the inputs needs to know whose they are; omitted only where no wallet context exists. */
  wallet?: {readonly groupId: string; readonly accountIndex: number},
): Promise<MidnightSendResult> => {
  const sponsored = await submitSponsoredTransfer(token, built.transaction, networkId)
  if (wallet !== undefined && built.consumedUtxoIds.length > 0) {
    await runMidnight(
      addUnshieldedLock(wallet.groupId, wallet.accountIndex, {
        consumedUtxoIds: built.consumedUtxoIds,
        expiresAt: Math.floor(Date.now() / 1000) + TTL_SECONDS,
        identifiers: built.identifiers,
      }),
    )
  }
  // Logged on success too: a send that reports nothing cannot be told from one that never ran. The
  // identifier values, not just a count — they are the only handle a submitted transfer has, so "did it
  // land?" is answerable from a log rather than from the device's storage. They are public on chain.
  logger.info('transfer submitted for sponsorship', {
    origin: ORIGIN,
    bytes: built.transaction.length,
    identifiers: built.identifiers,
    // ⚠️ Present means the sponsor submitted it and the node took it. Absent means the sponsor
    // accepted the bytes without saying where they went — which is what every send looked like
    // before the sponsor started waiting, and is worth being able to tell apart in a log.
    ...(sponsored.txId === undefined ? {landed: 'unreported'} : {txId: sponsored.txId}),
  })
  return {
    size: built.transaction.length,
    identifiers: built.identifiers,
    ...(built.state === undefined ? {} : {state: built.state}),
  }
}

/**
 * How many outputs this transfer's change should come back in.
 *
 * ⚠️ **NIGHT only.** A DUST generation is backed by a NIGHT UTxO, so splitting any other token's change
 * fragments the wallet and buys nothing. `1` is the answer for everything else.
 *
 * The count is derived from the wallet's *post-transaction* UTxO count, which is what the policy is
 * about — see `./night-spread.ts` for why a wallet wants its NIGHT spread and what bounds the split.
 */
export const plannedChangeChunks = (
  tokenType: string,
  held: readonly UnshieldedUtxo[],
  chosen: readonly UnshieldedUtxo[],
  amount: bigint,
): number => {
  if (tokenType !== NIGHT_TOKEN_TYPE) return 1
  const spent = chosen.reduce((total, one) => total + one.value, 0n)
  const change = spent - amount
  if (change <= 0n) return 1
  // Every NIGHT output we keep, plus the ones this transfer does not touch — the change output itself
  // is what the plan is deciding how to divide, so it is excluded.
  const chosenIds = new Set(chosen.map((one) => `${one.intentHash}:${one.outputIndex}`))
  const remaining = held.filter(
    (one) => one.tokenType === NIGHT_TOKEN_TYPE && !chosenIds.has(`${one.intentHash}:${one.outputIndex}`),
  ).length
  return planChangeSplit({
    changeStars: change,
    utxosAfterExcludingChange: remaining,
    policy: DEFAULT_NIGHT_SPREAD,
  }).length
}

/**
 * Build and sign an unshielded transfer, and stop there.
 *
 * Split out for the dApp connector's `makeTransfer`, which must hand the bytes back to a page rather
 * than submit them. Sharing the builder is the point: a transfer a dApp asked for and one the send
 * screen asked for must be the same transaction, selected the same way.
 */
export const buildUnshielded = async (params: {
  readonly nightRoleKey: Uint8Array
  readonly recipientPayload: Uint8Array
  readonly tokenType: string
  readonly amount: bigint
  readonly utxos: readonly UnshieldedUtxo[]
  readonly networkId: string
}): Promise<MidnightBuiltTransfer> => {
  const selection = selectUnshieldedInputs(params.utxos, params.tokenType, params.amount)
  if (!selection.ok) {
    // Two different problems, and telling them apart matters: one means the money is not there, the
    // other that it is there in too many pieces for one transfer to carry. See the note on
    // MAX_UNSHIELDED_INPUTS for why the second is a hard ledger limit and not a size heuristic.
    throw new MidnightBuildError({
      cause: selection.reason === 'too-many-inputs' ? 'too-many-inputs' : 'insufficient-funds',
      reason:
        selection.reason === 'too-many-inputs'
          ? 'this amount is spread across too many outputs for one Midnight transfer — consolidate first'
          : 'not enough unshielded funds to cover this amount',
    })
  }
  const chosen = selection.inputs
  const changeChunks = plannedChangeChunks(params.tokenType, params.utxos, chosen, params.amount)

  const tx = await walletBuildUnshieldedTransfer({
    nightRoleKey: params.nightRoleKey,
    inputs: chosen.map(toSpend),
    recipientAddress: params.recipientPayload,
    tokenType: decodeHex(params.tokenType, 'token type'),
    value: params.amount,
    networkId: params.networkId,
    ttlSecs: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    changeChunks,
  })
  logger.info('unshielded transfer built', {
    origin: ORIGIN,
    bytes: tx.length,
    inputs: chosen.length,
    changeChunks,
    network: params.networkId,
  })

  // Read before submitting: after the hand-off the bytes are the sponsor's, and a send that is already
  // in flight with no identifiers recorded is the case this exists to prevent.
  return {transaction: tx, identifiers: await identifiersOf(tx), consumedUtxoIds: chosen.map(unshieldedUtxoId)}
}

/**
 * Build, prove and submit a shielded transfer.
 *
 * Seconds of CPU — three protocol circuits — and the artifacts have to be cached first, so callers
 * should have told the user what is happening before awaiting this.
 */
/**
 * Build and prove a shielded transfer, and stop there — the `makeTransfer` half of {@link sendShielded}.
 *
 * ⚠️ **The returned state must be persisted even though nothing was submitted.** The coins are marked
 * pending by the builder, and a caller that discards the state lets the next transfer select the same
 * notes, which the ledger rejects. That is true whether or not the transaction is ever sent.
 */
export const buildShielded = async (params: {
  readonly state: WalletStateBytes
  readonly zswapRoleKey: Uint8Array
  readonly recipientCoinPublicKey: Uint8Array
  readonly recipientEncryptionPublicKey: Uint8Array
  readonly tokenType: string
  readonly amount: bigint
  readonly networkId: string
}): Promise<MidnightBuiltTransfer> => {
  const artifacts = await ensureZswapArtifacts()
  const transfer = await walletBuildTransfer({
    state: params.state,
    zswapRoleKey: params.zswapRoleKey,
    recipientCoinPublicKey: params.recipientCoinPublicKey,
    recipientEncryptionPublicKey: params.recipientEncryptionPublicKey,
    color: decodeHex(params.tokenType, 'token type'),
    value: params.amount,
    networkId: params.networkId,
    ttlSecs: Math.floor(Date.now() / 1000) + TTL_SECONDS,
    artifacts,
  })
  logger.info('shielded transfer proved', {
    origin: ORIGIN,
    bytes: transfer.transaction.length,
    network: params.networkId,
  })

  return {
    transaction: transfer.transaction,
    identifiers: await identifiersOf(transfer.transaction),
    // Empty, not omitted: a shielded transfer spends coins, not unshielded outputs, and its own
    // pending-coin tracking lives in the wallet state the SDK returns above.
    consumedUtxoIds: [],
    state: transfer.state,
  }
}
