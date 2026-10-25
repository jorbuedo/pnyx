/**
 * Bring a funds group's shielded state up to date, and persist it.
 *
 * The seam between the three things that each own a piece: the vault holds the mnemonic, `@pnyx/wallet`
 * derives the role key from it, and `@pnyx/midnight-native` applies chain data to the state. Nothing here
 * knows what a coin is.
 *
 * ⚠️ **Syncing needs the role key and therefore the vault**, because discovering a coin means decrypting
 * output ciphertexts. Reading a balance does not (`useMidnightShieldedBalance`), which is why the two are
 * separate: a balance renders while locked, a refresh asks for biometrics.
 *
 * ⚠️ **Bounded, and that is not a placeholder.** Scanning locally is the private way to find coins — the
 * alternative hands the indexer a viewing key and tells its operator everything the wallet holds — but it
 * costs a request per block. So a sync walks from the stored cursor to the tip with a ceiling, saves what
 * it reached, and the next run continues.
 *
 * **Where a first sync starts is the wallet's birthday** — the height its seed was created at, recorded
 * then and carried in the passkey recovery blob (plan item 61(a)). Nothing the wallet can hold is older,
 * so a walk from there is complete. A wallet with no birthday — one created before that existed, or a
 * seed imported from elsewhere — falls back to a window below the tip, and what it finds is what this
 * device could see rather than what the seed holds.
 *
 * ⚠️ **One call walks to the tip, not one window** (plan item 62(b)). A window is the unit of *saving*,
 * not the unit of work: each one persists before the next begins, so a cancel, a crash or a backgrounded
 * app keeps everything already scanned and the next run resumes from it. Before this, one tap walked 60
 * blocks and stopped — catching up from a birthday a day back was some 240 taps, and the rail was
 * effectively unusable for any wallet that was not already current. The biometric that unlocked the
 * mnemonic covers the whole walk, so the loop costs no extra prompt.
 *
 * @module
 */

import {Roles} from '@midnight-ntwrk/wallet-sdk-hd'
import {type WalletStateBytes, walletStateNew} from '@pnyx/midnight-native'
import {type DerivationError, deriveMidnightRoleKey} from '@pnyx/wallet'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Effect} from 'effect'

import {logger} from '../../../logger'
import {settleShieldedSends} from './settle-pending-sends'
import {fetchTipHeight, ShieldedSyncError, syncShieldedRange} from './shielded-sync'
import {
  loadShieldedBirthday,
  loadShieldedCursor,
  loadShieldedState,
  type ShieldedStoreError,
  saveShieldedCursor,
  saveShieldedState,
} from './state-store'
import {syncWindow} from './sync-window'

export {type ShieldedBirthday, syncWindow} from './sync-window'

const ORIGIN = 'midnight-wallet-sync'

/**
 * How many blocks one window covers — the unit of **saving**, and now also the range of one
 * subscription.
 *
 * ⚠️ **Raised from 60 when the walk stopped fetching and started streaming.** A window used to cost
 * four HTTP requests; it now costs one socket, and a socket's connect-and-acknowledge is paid whole
 * however few blocks follow it. At 60 a 157,000-block backfill would open 2,600 of them and spend more
 * time greeting the indexer than reading from it.
 *
 * What bounds it in the other direction is memory and the cost of a crash: frames arrive faster than
 * the native wallet applies them and a socket cannot be told to wait, so a window is held in memory at
 * roughly 1.5 KiB a block — about 1.5 MiB here — and an interrupted window is rescanned from its start,
 * which at streaming speed is a couple of seconds.
 */
export const SYNC_BLOCK_WINDOW = 1_000

export type ShieldedSyncOutcome = {
  readonly height: number
  readonly blocksScanned: number
  readonly transactionsApplied: number
  /**
   * True when the walk reached the tip, so a caller can tell "current" from "still catching up".
   *
   * ⚠️ **This is load-bearing, not informational.** `build-transfer.ts` refuses to build a shielded
   * transfer from a state that has not caught up, because selecting from a partial set finds too few
   * coins and reports the user's own money as missing — see `requireCaughtUp`.
   */
  readonly caughtUp: boolean
}

/** Where a walk has got to, reported between windows so a screen can show it moving. */
export type ShieldedSyncProgress = {
  /** The last height applied. */
  readonly height: number
  /** The tip as it was read at the start — the walk's target, so a caller can show a proportion. */
  readonly tip: number
  readonly blocksScanned: number
  readonly transactionsApplied: number
}

/**
 * Sync and persist. Returns `null` when there is nothing to sync against — no indexer for this network —
 * rather than reporting a successful sync of nothing.
 *
 * The state is written **before** the cursor. A crash between the two costs a re-scan of one window,
 * which is harmless; the other order could advance the cursor past coins the state never received.
 */
export const syncShieldedWallet = (params: {
  readonly groupId: string
  readonly accountIndex: number
  readonly mnemonic: string
  readonly network: string | null
  readonly blockWindow?: number
  /**
   * Stop after this many windows rather than walking to the tip. For a caller that wants a bounded
   * refresh — a probe, a test — and never for a user-facing sync, which must be able to finish.
   */
  readonly maxWindows?: number
  /** Reported between windows, so a screen can show the walk moving rather than a spinner. */
  readonly onProgress?: (progress: ShieldedSyncProgress) => void
  /**
   * Asked between windows; `false` stops the walk. Everything already scanned stays saved, so
   * cancelling costs nothing and the next run resumes from it.
   */
  readonly shouldContinue?: () => boolean
}): Effect.Effect<ShieldedSyncOutcome | null, ShieldedSyncError | ShieldedStoreError | DerivationError> =>
  Effect.gen(function* () {
    const network = params.network
    if (network === null) {
      // Was reached only through `fetchTipHeight` returning null for an unconfigured network. Named
      // explicitly now because the state is stamped with the network it belongs to, and there is no
      // honest stamp for "none" — a state saved under one would be unreadable on every real network.
      logger.warn('shielded sync skipped: no network selected', {origin: ORIGIN})
      return null
    }

    // `not-configured` is skipped, everything else propagates. Before the tip read had a typed failure
    // both arrived as `null`, so a broken indexer was logged as this build having none for the network.
    const tipOrSkip = yield* fetchTipHeight(network).pipe(
      Effect.catchIf(
        (error) => error.cause === 'not-configured',
        () => Effect.succeed('no-indexer' as const),
      ),
    )
    if (tipOrSkip === 'no-indexer') {
      logger.warn('shielded sync skipped: no indexer for network', {origin: ORIGIN, network})
      return null
    }
    if (tipOrSkip === null) {
      // The indexer answered and named no height. Distinct from having none configured, and logged
      // separately — returning here without a line is how a sync that never ran looks like one that did.
      logger.warn('shielded sync skipped: the indexer answered but named no tip', {origin: ORIGIN, network})
      return null
    }
    const tip = tipOrSkip

    const birthday = yield* loadShieldedBirthday(params.groupId, network)
    const startCursor = yield* loadShieldedCursor(params.groupId, params.accountIndex, network)
    if (startCursor === undefined && birthday === undefined) {
      // Not a failure, and not silent either: this is the wallet whose history starts wherever the
      // chain happens to be, and that is the one fact a later "your balance is 0" depends on.
      logger.warn('shielded first sync has no birthday: starting below the tip', {
        origin: ORIGIN,
        groupId: params.groupId,
        network,
      })
    }

    const window = params.blockWindow ?? SYNC_BLOCK_WINDOW
    const firstRange = syncWindow({tip, cursor: startCursor, birthday, window})
    if (firstRange === null) {
      return {height: tip, blocksScanned: 0, transactionsApplied: 0, caughtUp: true}
    }

    const stored = yield* loadShieldedState(params.groupId, params.accountIndex, network)
    let state: WalletStateBytes =
      stored ??
      (yield* Effect.tryPromise({
        try: () => walletStateNew(),
        catch: (error) => new ShieldedSyncError({cause: 'native', reason: String(error)}),
      }))

    const seed = mnemonicToSeedSync(params.mnemonic)
    const zswapRoleKey = yield* deriveMidnightRoleKey(seed, Roles.Zswap, {account: params.accountIndex})

    let cursor = startCursor
    let height = firstRange.fromHeight - 1
    let scanned = 0
    let applied = 0
    let windows = 0
    let stoppedEarly: 'cancelled' | 'budget' | undefined

    // Windowed rather than one long range, because a window is where progress is **saved**: the state
    // is written before its cursor, so a crash between them costs a rescan of one window and never
    // advances past coins the state did not receive.
    for (;;) {
      const range = syncWindow({tip, cursor, birthday, window})
      if (range === null) break
      if (params.maxWindows !== undefined && windows >= params.maxWindows) {
        stoppedEarly = 'budget'
        break
      }
      // ⚠️ Checked **between** windows, never inside one: a half-applied range is a tree the chain does
      // not share, and there is no way to persist half of it.
      if (params.shouldContinue !== undefined && !params.shouldContinue()) {
        stoppedEarly = 'cancelled'
        break
      }

      const result = yield* syncShieldedRange({
        state,
        zswapRoleKey,
        fromHeight: range.fromHeight,
        toHeight: range.toHeight,
        collapseFirst: range.collapseFirst,
        network,
      })

      state = result.state
      yield* saveShieldedState(params.groupId, params.accountIndex, state, network)
      yield* saveShieldedCursor(params.groupId, params.accountIndex, result.height)

      // A walk that stops making progress must not loop for ever. `syncShieldedRange` breaks out of a
      // height the indexer cannot answer for and returns what it reached, so this is the case where the
      // chain has a gap we cannot cross — reported rather than retried until the battery runs out.
      if (result.height <= height) {
        logger.warn('shielded sync stopped: the walk made no progress', {
          origin: ORIGIN,
          at: result.height,
          tip,
        })
        break
      }

      cursor = result.height
      height = result.height
      scanned += result.blocksScanned
      applied += result.transactionsApplied
      windows += 1
      params.onProgress?.({height, tip, blocksScanned: scanned, transactionsApplied: applied})
    }

    // Logged on success, not only on failure. A silent success is indistinguishable from never having run,
    // which cost real time: a pull-to-refresh was judged broken because nothing appeared in the log.
    logger.info('shielded sync applied', {
      origin: ORIGIN,
      from: firstRange.fromHeight,
      to: height,
      blocks: scanned,
      applied,
      windows,
      birthday: birthday?.height ?? 'none',
      collapsed: firstRange.collapseFirst,
      // Named, because "caught up" and "stopped at the budget" look identical in a count of blocks.
      stoppedEarly: stoppedEarly ?? 'no',
    })

    // ⚠️ The only place a shielded send's outcome is ever learned. The unshielded feed settles when an
    // unshielded transaction arrives, and a shielded transfer never produces one — so without this call
    // a send that landed stays pending for ever. Here rather than anywhere else because this is the act
    // a user performs when they want to know whether their money moved.
    yield* settleShieldedSends(params.groupId, params.accountIndex, network)

    return {
      height,
      blocksScanned: scanned,
      transactionsApplied: applied,
      caughtUp: height >= tip,
    }
  })
