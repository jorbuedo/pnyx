/**
 * A send that pays its own Midnight fee, with no sponsor anywhere in it.
 *
 * The sponsored path leaves a transfer **unbound** so the service can merge a DUST fee into it. This
 * one spends the wallet's own DUST, proves that spend (`midnight/dust/spend`, K=13) and seals — so
 * there is nothing for a sponsor to add, and `./submit-sealed.ts` takes it straight to the node.
 *
 * ⚠️ **Unshielded only.** The native self-funding builder takes unshielded inputs and an unshielded
 * recipient; there is no shielded equivalent. A caller that wants "pay my own way if you can" must
 * fall back for the shielded rail rather than assume — which is what `./fee-payer.ts` decides.
 *
 ## Build and submit are separate, and that is what makes a fallback safe
 *
 * A caller on `prefer-self` has to be able to give up and let the sponsor pay. That is only sound
 * while nothing has been sent, so the step that sends is its own call: a {@link buildSelfFundedSend}
 * that throws has put nothing on chain and may be retried any way the caller likes, whereas anything
 * after {@link submitSelfFundedSend} has. Folding the two together would leave a caller unable to tell
 * "could not pay for itself" from "paid for itself and then something went wrong", and falling back on
 * the second sends the money twice.
 *
 * The *state the build returns* must be recorded because the fee spent one of its outputs — keeping only
 * the old one would let the next send pick the same DUST output, which the ledger rejects. It is
 * recorded as a **pending** spend rather than written over the confirmed state: the transaction can
 * still be dropped, and overwriting had no way back, so a transfer that never landed took its DUST with
 * it permanently. The pending record carries the transaction's own TTL and reverts on its own.
 *
 * @module
 */

import {Roles} from '@midnight-ntwrk/wallet-sdk-hd'
import {hex} from '@pnyx/crypto'
import {nightPayload, walletBuildSelfFundedTransfer} from '@pnyx/midnight-native'
import {deriveMidnightRoleKey, encodeNightAddress, parseMidnightAddress} from '@pnyx/wallet'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Effect} from 'effect'

import {logger} from '../../logger'
import {ensureDustArtifacts} from '../pnyx-artifacts'
import {MidnightBuildError, requireCaughtUp} from './build-failure'
import {runMidnight} from './effect-boundary'
import {selectUnshieldedInputs} from './input-selection'
import {plannedChangeChunks} from './send'
import {type SubmitSealedError, submitSealedTransaction} from './submit-sealed'
import {rememberSyncKeysForScheduler} from './sync-keys'
import {loadDustStateForSpend, markDustSpent, savePendingDustSpend} from './wallet/dust-state-store'
import {SPEND_CATCH_UP_TIMEOUT_MS, syncUnshieldedWallet} from './wallet/unshielded'
import {addUnshieldedLock, unshieldedUtxoId} from './wallet/unshielded-pending-store'

const ORIGIN = 'midnight-send-self-funded'

/** An hour. Far-future TTLs are rejected at submission as `Custom error: 182`, which names nothing. */
const TTL_SECONDS = 3600

export type SelfFundedSendParams = {
  readonly groupId: string
  readonly accountIndex: number
  /** Bech32m `mn_addr…` — this rail has no shielded form. */
  readonly recipient: string
  readonly tokenType: string
  readonly amount: bigint
  /** The Midnight funds network, e.g. `preprod`. */
  readonly networkId: string
  /** Localized biometric-prompt title — the vault needs one. */
  readonly biometricPrompt: string
}

/** A sealed, self-funded transfer that has **not** been sent. Nothing is on chain until it is. */
export type BuiltSelfFundedSend = {
  readonly transaction: Uint8Array
  /** The DUST state with the fee's output spent. Recorded by {@link submitSelfFundedSend}, not before. */
  readonly dustState: Uint8Array
  /** Unix seconds this transaction stops being acceptable — what the pending spend expires on. */
  readonly expiresAt: number
  /** `intentHash:outputIndex` of the unshielded inputs it spends, so the submit can lock them. */
  readonly consumedUtxoIds: readonly string[]
  /** SPECK the transaction will pay. `0n` is normal on an idle chain. */
  readonly fee: bigint
  /** The transaction's identifiers, for matching it on chain — read by the builder before it sealed. */
  readonly identifiers: readonly string[]
}

export type SelfFundedSendResult = {
  /** SPECK the transaction actually paid. `0n` is normal on an idle chain. */
  readonly fee: bigint
  /** blake2-256 of the submitted extrinsic — a sealed transaction's bytes are final, so it has one. */
  readonly extrinsicHash: string
  readonly size: number
  /** The transaction's identifiers, for matching it on chain — read by the builder before it sealed. */
  readonly identifiers: readonly string[]
}

/** Indexer hex, or a named failure. Never a zero-filled fallback: that would spend the wrong output. */
const decodeHex = (text: string, what: string): Uint8Array => {
  const decoded = hex.decode(text)
  if (decoded._tag === 'Left') {
    throw new MidnightBuildError({cause: 'malformed-input', reason: `${what} is not hex: ${text}`})
  }
  return decoded.right
}

/**
 * Build, prove and seal a transfer that pays its own fee. **Sends nothing.**
 *
 * Throws with a stated reason rather than falling back to the sponsor. Falling back is a *policy*
 * choice that belongs to the caller and to `./fee-payer.ts`; making it here would let a caller that
 * explicitly asked to pay its own way be sponsored anyway. Because nothing has been sent, a throw is
 * always safe to recover from.
 */
export const buildSelfFundedSend = async (params: SelfFundedSendParams): Promise<BuiltSelfFundedSend> => {
  const recipient = parseMidnightAddress(params.recipient)
  if (!recipient.ok) {
    throw new MidnightBuildError({cause: 'invalid-recipient', reason: 'recipient address is not readable'})
  }
  if (recipient.kind !== 'night') {
    throw new MidnightBuildError({
      cause: 'invalid-recipient',
      reason: 'a self-funded transfer needs an unshielded recipient address',
    })
  }

  const {createEnclaveMnemonicVault} = await import('../credential-vault')
  const mnemonic = await Effect.runPromise(
    createEnclaveMnemonicVault().retrieve(params.groupId, params.biometricPrompt),
  )
  const seed = mnemonicToSeedSync(mnemonic)
  // The vault has just been unlocked, so the scheduler can be handed what it needs to keep DUST
  // current afterwards without asking again. See `rememberSyncKeysForScheduler`.
  void rememberSyncKeysForScheduler(params.groupId, params.accountIndex, mnemonic, params.networkId)
  const [nightRoleKey, dustRoleKey] = await Promise.all([
    Effect.runPromise(deriveMidnightRoleKey(seed, Roles.NightExternal, {account: params.accountIndex})),
    Effect.runPromise(deriveMidnightRoleKey(seed, Roles.Dust, {account: params.accountIndex})),
  ])

  // Through the caching path, not `syncUnshielded` directly: that one replays from transaction 0 and
  // discards what it learned, so a send left the cache at its stalest exactly when someone was most
  // likely looking at it. One writer also means one place for the spendable overlay to attach.
  const synced = await runMidnight(
    syncUnshieldedWallet({
      groupId: params.groupId,
      accountIndex: params.accountIndex,
      address: encodeNightAddress(nightPayload(nightRoleKey), params.networkId),
      network: params.networkId,
      timeoutMs: SPEND_CATCH_UP_TIMEOUT_MS,
    }),
  )
  requireCaughtUp(synced.caughtUp, 'a self-funded transfer', 'unshielded')
  const selection = selectUnshieldedInputs(synced.utxos, params.tokenType, params.amount)
  if (!selection.ok) {
    throw new MidnightBuildError({
      cause: selection.reason === 'too-many-inputs' ? 'too-many-inputs' : 'insufficient-funds',
      reason:
        selection.reason === 'too-many-inputs'
          ? 'this amount is spread across too many outputs for one Midnight transfer — consolidate first'
          : 'not enough unshielded funds to cover this amount',
    })
  }

  // Fetched before building rather than lazily inside it: this is the step that can take seconds on a
  // cold cache, and a caller showing progress needs it to be its own phase.
  const {artifactDir, paramsDir} = await ensureDustArtifacts()

  // ⚠️ **The state and its block time, read as a pair, and read *here*.** A dust spend proof commits to
  // our tree roots and the node looks its own up under the timestamp the spend declares —
  // `root_history.get(ctime)` — so a state from one sync with another sync's timestamp resolves to roots
  // the proof never used, reported as `InvalidDustSpendProof`.
  //
  // ⚠️ Deliberately after the vault unlock, the unshielded sync and the artifact fetch. Reading the state
  // at the top of this function and the time down here left a window of tens of seconds for a DUST
  // refresh to replace one of them — which produced exactly that `170` on device, and could not bite
  // while every state's block time was `0` and the send refused before building.
  const dust = await runMidnight(loadDustStateForSpend(params.groupId, params.accountIndex, params.networkId))
  if (dust === undefined) {
    // Distinct from "holds no DUST": nobody has looked, and the fix is a sync rather than funding.
    throw new MidnightBuildError({
      cause: 'not-ready',
      reason: 'this wallet has not synced its DUST yet, so it cannot pay its own fee',
    })
  }
  const {state: dustState, blockTimeSecs: ctimeSecs} = dust
  if (ctimeSecs === 0) {
    // A state whose trees never reached a block we can name. Refusing beats building a transaction the
    // node is certain to refuse for a reason that names the proof.
    throw new MidnightBuildError({
      cause: 'not-ready',
      reason: 'this wallet’s DUST state has no block time — refresh its DUST before paying with it',
    })
  }
  const now = Math.floor(Date.now() / 1000)
  // Same policy as a sponsored send: keep NIGHT spread so a fee always has a DUST output that can cover
  // it. This path is the one that pays its own fee, so it is the one that benefits most.
  const changeChunks = plannedChangeChunks(params.tokenType, synced.utxos, selection.inputs, params.amount)
  const built = await walletBuildSelfFundedTransfer({
    nightRoleKey,
    inputs: selection.inputs.map((utxo) => ({
      value: utxo.value,
      tokenType: decodeHex(utxo.tokenType, 'token type'),
      intentHash: decodeHex(utxo.intentHash, 'intent hash'),
      outputIndex: utxo.outputIndex,
    })),
    recipientAddress: recipient.payload,
    tokenType: decodeHex(params.tokenType, 'token type'),
    value: params.amount,
    networkId: params.networkId,
    ttlSecs: now + TTL_SECONDS,
    dustState,
    dustRoleKey,
    ctimeSecs,
    artifactDir,
    paramsDir,
    changeChunks,
  })
  // From the builder, which read them before sealing. `identifiersOf` cannot: it deserializes a
  // `ProvenTx` and this transaction is sealed, which is why every self-funded send used to be recorded
  // with none — and then refused by the pending-send store, landing on chain and appearing nowhere.
  const identifiers = built.identifiers
  logger.info('a self-funded transfer was built', {
    origin: ORIGIN,
    network: params.networkId,
    bytes: built.transaction.length,
    inputs: selection.inputs.length,
    changeChunks,
    fee: built.fee.toString(),
    identifiers,
  })

  return {
    transaction: built.transaction,
    dustState: built.dustState,
    expiresAt: now + TTL_SECONDS,
    consumedUtxoIds: selection.inputs.map(unshieldedUtxoId),
    fee: built.fee,
    identifiers,
  }
}

/**
 * Send a built self-funded transfer, then record the DUST state its fee left behind.
 *
 * ⚠️ **Past this point a fallback is unsafe.** Once the node has the bytes, retrying through the
 * sponsor sends the same money twice — so a caller on `prefer-self` must fall back on a
 * {@link buildSelfFundedSend} failure only, never on one from here.
 *
 * The state write is deliberately after the submit and deliberately not fatal to it: a send that
 * landed but whose state could not be recorded is a bookkeeping problem, and throwing would report a
 * completed send as failed. It is logged at `error` because the next send will then reuse a spent
 * DUST output and be rejected — a real defect, just not this send's.
 */
export const submitSelfFundedSend = (params: {
  readonly groupId: string
  readonly accountIndex: number
  readonly networkId: string
  readonly built: BuiltSelfFundedSend
}): Effect.Effect<SelfFundedSendResult, SubmitSealedError> =>
  Effect.gen(function* () {
    // ⚠️ The failure travels **typed** all the way to the screen, and it has to. Only
    // `cause === 'rejected'` means the node saw the bytes and refused them, which is the sole case where
    // falling back to the sponsor cannot send the money twice. Flattening this to an `Error` would make
    // every failure look un-rejected and silently disable the fallback.
    const {extrinsicHash} = yield* submitSealedTransaction({
      transaction: params.built.transaction,
      network: params.networkId,
    })

    // Not fatal to the submit, deliberately: the send has landed, and reporting a completed send as
    // failed because its bookkeeping did not write is the worse error. Logged at `error` because the
    // next send will then reuse a spent DUST output and be rejected — a real defect, just not this one's.
    yield* Effect.gen(function* () {
      // Before the pending write, and never unset: from here on the fast sync cannot rebuild this wallet,
      // because its DUST outputs now have successors the per-address feed does not carry. Recording it
      // first means a crash between the two leaves the safe combination — a refused sync — rather than a
      // wallet that will silently rebuild itself into unspendable outputs.
      yield* markDustSpent(params.groupId, params.accountIndex)
      // Pending, not confirmed. The node has the bytes but the chain has not shown them, and a transfer
      // that is dropped must give its DUST back rather than take it with it.
      yield* savePendingDustSpend(params.groupId, params.accountIndex, {
        state: params.built.dustState,
        expiresAt: params.built.expiresAt,
        identifiers: params.built.identifiers,
      })
      if (params.built.consumedUtxoIds.length > 0) {
        yield* addUnshieldedLock(params.groupId, params.accountIndex, {
          consumedUtxoIds: params.built.consumedUtxoIds,
          expiresAt: params.built.expiresAt,
          identifiers: params.built.identifiers,
        })
      }
    }).pipe(
      Effect.catchAll((error) =>
        Effect.sync(() => {
          logger.error('a self-funded transfer landed but its dust spend was not recorded; re-sync before the next', {
            origin: ORIGIN,
            network: params.networkId,
            extrinsicHash,
            error: error.reason,
          })
        }),
      ),
    )

    logger.info('a self-funded transfer was submitted', {
      origin: ORIGIN,
      network: params.networkId,
      extrinsicHash,
      fee: params.built.fee.toString(),
    })
    return {
      fee: params.built.fee,
      extrinsicHash,
      size: params.built.transaction.length,
      identifiers: params.built.identifiers,
    }
  })
