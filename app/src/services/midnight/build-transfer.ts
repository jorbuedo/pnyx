/**
 * Building a Midnight transfer from what a review screen knows.
 *
 * Extracted from `MidnightReviewScreen` so the dApp connector's `makeTransfer` can produce the *same*
 * transaction the send funnel produces. Two builders for one kind of transfer would drift — different
 * input selection, a different TTL, a different rail decision — and the difference would only ever show
 * up on chain.
 *
 * Everything key-shaped happens here and nowhere above: the vault is opened once, the role key is
 * derived for the rail in question, and the seed leaves scope with the function. Callers get bytes.
 *
 * ⚠️ **Building is not sending.** This returns a signed, unbound transaction and submits nothing. The
 * shielded rail marks its coins pending as a side effect of building, so the returned state must be
 * persisted even by a caller that never submits — see {@link MidnightBuiltTransfer}.
 *
 * @module
 */

import {Roles} from '@midnight-ntwrk/wallet-sdk-hd'
import {nightPayload} from '@pnyx/midnight-native'
import {deriveMidnightRoleKey, encodeNightAddress, parseMidnightAddress} from '@pnyx/wallet'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {MidnightBuildError, requireCaughtUp} from './build-failure'
import {runMidnight} from './effect-boundary'
import {buildShielded, buildUnshielded, type MidnightBuiltTransfer} from './send'
import {rememberSyncKeysForScheduler} from './sync-keys'
import {freshnessAllowsBuild, shieldedFreshness} from './wallet/shielded-freshness'
import {fetchTipHeight} from './wallet/shielded-sync'
import {loadShieldedCursor, loadShieldedState} from './wallet/state-store'
import {SPEND_CATCH_UP_TIMEOUT_MS, syncUnshieldedWallet} from './wallet/unshielded'

const ORIGIN = 'midnight-build-transfer'

export type MidnightTransferRail = 'shielded' | 'unshielded'

export type BuildTransferParams = {
  readonly groupId: string
  readonly accountIndex: number
  readonly rail: MidnightTransferRail
  /** Bech32m, and it must match the rail: `mn_addr…` unshielded, `mn_shield-addr…` shielded. */
  readonly recipient: string
  readonly tokenType: string
  readonly amount: bigint
  /** The Midnight funds network, e.g. `preprod`. */
  readonly networkId: string
  /** Localized biometric-prompt title — the vault needs one. */
  readonly biometricPrompt: string
}

/** Our own unshielded address, for the UTxO query. Derived rather than read, so it matches the key. */
const ourUnshieldedAddress = (nightRoleKey: Uint8Array, networkId: string): string =>
  encodeNightAddress(nightPayload(nightRoleKey), networkId)

/** A shielded address carries both keys: `coinPublicKey(32) ‖ encryptionPublicKey(32)`. */
const decodeShieldedRecipient = (address: string): {coinPublicKey: Uint8Array; encryptionPublicKey: Uint8Array} => {
  const parsed = parseMidnightAddress(address)
  if (!parsed.ok)
    throw new MidnightBuildError({cause: 'invalid-recipient', reason: 'recipient address is not readable'})
  if (parsed.kind !== 'shielded') {
    throw new MidnightBuildError({
      cause: 'invalid-recipient',
      reason: 'a shielded transfer needs a shielded recipient address',
    })
  }
  if (parsed.payload.length !== 64) {
    throw new MidnightBuildError({
      cause: 'malformed-input',
      reason: `a shielded payload is 64 bytes, got ${parsed.payload.length}`,
    })
  }
  return {coinPublicKey: parsed.payload.slice(0, 32), encryptionPublicKey: parsed.payload.slice(32)}
}

/**
 * Build and sign a transfer on the rail the caller names.
 *
 * Throws with a stated reason: no shielded state, an unreadable or wrong-rail recipient, inputs that
 * cannot cover the amount, a native builder refusal. None of them is a silent no-op, because every one
 * of them means the transfer the user just approved does not exist.
 */
export const buildMidnightTransfer = async (params: BuildTransferParams): Promise<MidnightBuiltTransfer> => {
  const {createEnclaveMnemonicVault} = await import('../credential-vault')
  const mnemonic = await Effect.runPromise(
    createEnclaveMnemonicVault().retrieve(params.groupId, params.biometricPrompt),
  )
  const seed = mnemonicToSeedSync(mnemonic)
  // The vault has just been unlocked, so the scheduler can be handed what it needs to keep DUST
  // current afterwards without asking again. See `rememberSyncKeysForScheduler`.
  void rememberSyncKeysForScheduler(params.groupId, params.accountIndex, mnemonic, params.networkId)

  if (params.rail === 'shielded') {
    const state = await runMidnight(loadShieldedState(params.groupId, params.accountIndex, params.networkId))
    if (state === undefined) {
      throw new MidnightBuildError({
        cause: 'not-ready',
        reason: 'this wallet has no shielded state yet — sync the shielded rail first',
      })
    }
    // ⚠️ **Holding a state is not the same as having looked.** This branch used to stop at the check
    // above, so a wallet whose scan had reached nowhere near the tip built anyway — and the native
    // selector refused it with "holds 0 of this token, need N", stating a balance as fact when the
    // truth was that nothing had looked. The unshielded branch below has refused for this since
    // 2026-08-23; plan item 62(a) is the same fix on this rail. Unlike that branch, this one cannot
    // sync inline — a shielded walk needs the role key and takes minutes — so it reads the tip and
    // compares, which is one request.
    const freshness = shieldedFreshness(
      await runMidnight(
        fetchTipHeight(params.networkId).pipe(
          Effect.map((tip) => ({tip})),
          Effect.catchAll((error) => Effect.succeed({tip: null, tipFailure: error.reason})),
          Effect.flatMap((read) =>
            loadShieldedCursor(params.groupId, params.accountIndex, params.networkId).pipe(
              Effect.map((cursor) => ({cursor, ...read})),
              Effect.orElseSucceed(() => ({cursor: undefined, ...read})),
            ),
          ),
        ),
      ),
    )
    if (freshness.kind === 'unknown') {
      // Building anyway is the decision `shielded-freshness` documents. It must not be silent: "we did
      // not check" and "we checked and it was fine" are different facts, and only one of them explains
      // a later surprise.
      logger.warn('building a shielded transfer without establishing freshness', {
        origin: ORIGIN,
        cursor: freshness.cursor,
        reason: freshness.reason,
      })
    }
    requireCaughtUp(freshnessAllowsBuild(freshness), 'a shielded transfer', 'shielded')
    const zswapRoleKey = await Effect.runPromise(
      deriveMidnightRoleKey(seed, Roles.Zswap, {account: params.accountIndex}),
    )
    const recipientKeys = decodeShieldedRecipient(params.recipient)
    logger.debug('building a shielded transfer', {origin: ORIGIN, network: params.networkId})
    return buildShielded({
      state,
      zswapRoleKey,
      recipientCoinPublicKey: recipientKeys.coinPublicKey,
      recipientEncryptionPublicKey: recipientKeys.encryptionPublicKey,
      tokenType: params.tokenType,
      amount: params.amount,
      networkId: params.networkId,
    })
  }

  const nightRoleKey = await Effect.runPromise(
    deriveMidnightRoleKey(seed, Roles.NightExternal, {account: params.accountIndex}),
  )
  const recipient = parseMidnightAddress(params.recipient)
  if (!recipient.ok) {
    throw new MidnightBuildError({cause: 'invalid-recipient', reason: 'recipient address is not readable'})
  }
  if (recipient.kind !== 'night') {
    throw new MidnightBuildError({
      cause: 'invalid-recipient',
      reason: 'an unshielded transfer needs an unshielded recipient address',
    })
  }
  // Through the caching path, not `syncUnshielded` directly: that one replays from transaction 0 and
  // discards what it learned, so a send left the cache at its stalest exactly when someone was most
  // likely looking at it. One writer also means one place for the spendable overlay to attach.
  const synced = await runMidnight(
    syncUnshieldedWallet({
      groupId: params.groupId,
      accountIndex: params.accountIndex,
      address: ourUnshieldedAddress(nightRoleKey, params.networkId),
      network: params.networkId,
      timeoutMs: SPEND_CATCH_UP_TIMEOUT_MS,
    }),
  )
  requireCaughtUp(synced.caughtUp, 'an unshielded transfer', 'unshielded')
  logger.debug('building an unshielded transfer', {
    origin: ORIGIN,
    network: params.networkId,
    utxos: synced.utxos.length,
  })
  return buildUnshielded({
    nightRoleKey,
    recipientPayload: recipient.payload,
    tokenType: params.tokenType,
    amount: params.amount,
    utxos: synced.utxos,
    networkId: params.networkId,
  })
}
