/**
 * What the chain-sync scheduler runs for a Midnight chain.
 *
 * Until now the scheduler drove `loadCachedChainSnapshot` for every chain, and that function — as its
 * own module doc says — never talks to a chain: it reads a cached snapshot and stamps a time. Cardano
 * got away with it because its rail fetches elsewhere. Midnight did not: its unshielded UTxO set was
 * refreshed only when a hook mounted or a screen asked, which is why a balance could sit stale until
 * the app was restarted, and why one surface disagreed with another.
 *
 ## What is scheduled, and what a key changes
 *
 * Unshielded UTxOs are addressed in the clear, so reading them costs a socket and nothing else — that
 * one always runs. DUST needs a role key, so it runs **only while one is already held** from a refresh
 * the user asked for this session (`./sync-keys.ts`). No key, no DUST sync and no prompt: a timer that
 * made the phone ask for a fingerprint because a fiber woke up is not a refresh.
 *
 * The shielded rail is not here at all. Its key spends coins and there is no viewing-only form exposed
 * yet — `midnight-zswap` splits `encryption_secret_key` from `coin_secret_key`, and until a native op
 * hands over the first alone, a scheduled shielded sync would mean holding the second.
 *
 * @module
 */

import type {ChainId} from '@pnyx/config'
import {Effect} from 'effect'

import {logger} from '../../logger'
import {withDustSyncPermit} from './dust-sync-lock'
import {midnightFailureReason} from './effect-boundary'
import {midnightIndexerFor} from './networks'
import {getSyncKeys, heldNetworksFor} from './sync-keys'
import {loadDustHasSpent, loadDustRepairs, saveDustRepairs, saveDustState} from './wallet/dust-state-store'
import {syncDust} from './wallet/dust-sync'
import {syncUnshieldedWallet} from './wallet/unshielded'
import {feedKey, feedOwns} from './wallet/unshielded-live'
import {loadUnshieldedCache} from './wallet/unshielded-store'

const ORIGIN = 'midnight-scheduled-sync'

/**
 * Whether this chain id is the Midnight one.
 *
 * ⚠️ **The chain id does not name the funds network, and reading one out of it is a bug.** There is
 * exactly one Midnight chain id — `midnight:mainnet` — and it identifies the *identity* chain, which the
 * app uses whatever funds network is selected. Taking `mainnet` from it and syncing against that is how
 * the first device run failed: `getReceiveAddress` correctly returned the wallet's **preprod** address
 * and the sync was told to read mainnet, so the HRP check refused it
 * (`expected HRP mn_addr, but was mn_addr_preprod`). The funds network comes from
 * {@link midnightFundsNetwork} over the app's own network, like everywhere else.
 */
export const isMidnightChainId = (chainId: ChainId): boolean => String(chainId).startsWith('midnight:')

/**
 * Refresh a Midnight chain's unshielded set on the scheduler's behalf.
 *
 * Reports whether anything moved, which is what the scheduler uses to decide how eagerly to poll next.
 * "Applied nothing" is a real answer and not a failure — an idle wallet returns `false` every tick.
 *
 * Failures are swallowed into `false` rather than propagated. A scheduled refresh that throws would
 * mark the whole chain errored on the strength of one dropped socket, and the next tick retries anyway;
 * it is logged so a persistent failure is still visible.
 */
export const syncMidnightUnshielded = (params: {
  readonly groupId: string
  readonly accountIndex: number
  readonly chainId: ChainId
  readonly address: string
  /** The Midnight **funds** network — not anything read off the chain id. See {@link isMidnightChainId}. */
  readonly network: string
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!isMidnightChainId(params.chainId)) return false
    // A live feed is already listening to this wallet and writes as things land, so a tick would only
    // re-ask a question that is being answered continuously — and `transactionsApplied` is 0 under a
    // feed by construction, so the tick could not report a change anyway.
    if (feedOwns(feedKey(params.groupId, params.accountIndex, params.network))) return false
    const result = yield* syncUnshieldedWallet({
      groupId: params.groupId,
      accountIndex: params.accountIndex,
      address: params.address,
      network: params.network,
    })
    return result.transactionsApplied > 0
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        logger.warn('a scheduled midnight unshielded sync failed; the next tick retries', {
          origin: ORIGIN,
          groupId: params.groupId,
          chainId: params.chainId,
          error: error.reason,
        })
        return false
      }),
    ),
  )

/**
 * Keep DUST current on the schedule, but **only** while a key is already held.
 *
 * Returns `false` without doing anything when none is — that is the ordinary state for a wallet
 * nobody has refreshed this session, not a failure, and prompting for one here is exactly what this
 * design refuses to do.
 *
 * ⚠️ It also refuses a wallet that has spent DUST, for the reason `syncDust` does: those outputs have
 * successors the per-address feed does not carry, so a rebuilt state would hold unspendable ones
 * behind a plausible number.
 */
export const syncScheduledDust = (params: {
  readonly groupId: string
  readonly accountIndex: number
  readonly chainId: ChainId
  readonly network: string
}): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    if (!isMidnightChainId(params.chainId)) return false
    const keys = getSyncKeys(params.groupId, params.accountIndex, params.network)
    if (keys === undefined) {
      // ⚠️ **The usual reason DUST goes stale and stays stale, and it used to say nothing.** The DUST
      // role key comes from the seed, so a scheduled tick cannot derive one without a biometric prompt
      // — it can only use a key a user-initiated refresh happens to be holding. So after any unshielded
      // activity the state is `activity`-stale until the user refreshes by hand, `decideFeePayer` sends
      // every fee to the sponsor, and nothing anywhere recorded why. `debug` because it is expected and
      // fires every tick; silence is what was not acceptable.
      const elsewhere = heldNetworksFor(params.groupId, params.accountIndex)
      if (elsewhere.length > 0) {
        // ⚠️ **A key on another network and none here is no longer reachable by switching networks** —
        // `rememberSyncKeys` derives every known network from one prompt. What is left is a book
        // written before that (or a network this build gained afterwards), and it is a state a
        // scheduled tick can never clear on its own: re-deriving needs the seed, and a tick may not
        // prompt. So it is `info`, not `debug` — a condition needing a user-initiated refresh is not
        // the same fact as a wallet that simply has no key yet.
        logger.info('a dust key is held for other networks but not this one, so a refresh is needed here', {
          origin: ORIGIN,
          groupId: params.groupId,
          accountIndex: params.accountIndex,
          held: elsewhere,
          wanted: params.network,
        })
        return false
      }
      logger.debug('no sync keys are held, so dust cannot be kept current without asking the user', {
        origin: ORIGIN,
        groupId: params.groupId,
        network: params.network,
      })
      return false
    }
    const indexerUrl = midnightIndexerFor(params.network)
    if (indexerUrl === null) {
      // A build with no indexer for this network cannot sync DUST at all — a configuration fact rather
      // than a passing state, so it is worth more than `debug`.
      logger.warn('no midnight indexer is configured, so dust cannot be kept current', {
        origin: ORIGIN,
        groupId: params.groupId,
        network: params.network,
      })
      return false
    }
    // ⚠️ **Rebuild unless a rebuild is unavailable** — see `./refresh-dust.ts` for why that order, and
    // not the other one. A spend disqualifies the rebuild, not the tick: the stored state already holds
    // the successor outputs the builder created, so advancing it needs nothing the feed cannot give.
    // Only a wallet with no resumable state left is declined, which is a repair job, not a schedule.
    // ⚠️ See `./refresh-dust.ts`: the advance was measured against the chain on 2026-08-23 and does
    // not reproduce its generation root, while a rebuild that reinstates each spend's successor
    // reproduces both. So a spend no longer disqualifies the tick.
    const spentDustBefore = yield* loadDustHasSpent(params.groupId, params.accountIndex)
    const now = BigInt(Math.floor(Date.now() / 1000))
    // Discovery is sequential in `seq`, so starting from what is already known is what keeps a
    // routine sync to one rebuild instead of one per fee this wallet has ever paid.
    const knownRepairs = yield* loadDustRepairs(params.groupId, params.accountIndex, params.network)
    const synced = yield* withDustSyncPermit(
      params.groupId,
      params.accountIndex,
      syncDust({
        indexerUrl,
        dustAddress: keys.dustAddress,
        dustRoleKey: keys.dust,
        atUnixSecs: now,
        spentDustBefore,
        repairs: knownRepairs,
      }),
    )
    yield* saveDustRepairs(params.groupId, params.accountIndex, synced.repairs)
    const cached = yield* loadUnshieldedCache(params.groupId, params.accountIndex)
    yield* saveDustState(
      params.groupId,
      params.accountIndex,
      synced.state,
      Number(now),
      params.network,
      synced.syncTimeSecs,
      synced.cursor,
      cached?.transactionId,
    )
    // ⚠️ **`true` means "come back soon", and an outstanding repair step qualifies.** Each tick takes
    // one step along every output's spend history, so a wallet with a backlog converges over several
    // ticks instead of blocking one sync for minutes. The state written each time is spendable — only
    // value is outstanding, never correctness.
    logger.debug('kept dust current on the schedule', {
      origin: ORIGIN,
      groupId: params.groupId,
      entries: synced.entries,
      repairsOnRecord: synced.repairs.length,
      moreToRepair: synced.moreToRepair,
      utxos: synced.balance.utxos,
    })
    return synced.entries > 0 || synced.moreToRepair
  }).pipe(
    Effect.catchAll((error) =>
      Effect.sync(() => {
        const cause = 'cause' in error ? error.cause : 'store'
        // ⚠️ **A shape this build does not implement is not a failure to retry.** It was logged as a
        // warning on every scheduled tick, for ever, which is how a permanent and understood
        // condition came to look like a recurring fault and buried the ticks that were real.
        // Retrying is harmless but pointless: nothing changes until the app ships support for it.
        if (cause === 'unsupported') {
          logger.info('dust sync is not supported against this indexer; skipping it on this network', {
            origin: ORIGIN,
            groupId: params.groupId,
            error: midnightFailureReason(error),
          })
          return false
        }
        logger.warn('a scheduled dust sync failed; the next tick retries', {
          origin: ORIGIN,
          groupId: params.groupId,
          cause,
          error: midnightFailureReason(error),
        })
        return false
      }),
    ),
  )
