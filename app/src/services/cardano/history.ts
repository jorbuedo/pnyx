/**
 * Cardano transaction history: pull indexed txs touching the wallet's known
 * addresses (via the rail's provider) and run them through the tx-review
 * history producer into `ReviewedTransaction`s the review renderer consumes
 * in `mode="detail"`.
 *
 * @module
 */

import {
  Address as EvolutionAddress,
  type Provider as EvolutionProvider,
  type RewardAddress,
  TransactionHash,
} from '@evolution-sdk/evolution'
import {Bech32, TxHashHex} from '@evolution-sdk/review/Brands'
import {Decode} from '@evolution-sdk/review/Decode'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Address, Tx} from '@pnyx/cardano-core'
import {
  type HistoryWalletContext,
  type IndexedCardanoTx,
  type IndexedCertificate,
  type ResolvedInput,
  type ReviewedDRep,
  type ReviewedIO,
  type ReviewedTransaction,
  reviewCardanoFromHistory,
  reviewCardanoTx,
  reviewedBlockOf,
} from '@pnyx/tx-review'
import {Data, Effect} from 'effect'
import {logger} from '../../logger'
import {isByronAddress} from './byron-address'
import {getCardanoDataStore} from './cardano-store'
import {chainTip} from './chain-tip'
import {ownSmartWalletBech32} from './cip113/smart-wallet'
import {deserializeIndexedTx, indexedTxToRow} from './history-store'
import {witnessLeaksSigningKey} from './leaked-key'
import {resolveCardanoParams} from './params'
import {resolvePendingActivity} from './pending-activity'
import type {CardanoRail} from './rail'
import {
  backfillComplete,
  canSkipHistoryWalk,
  type HistoryReach,
  type HistoryWalkPlan,
  historyWalkPlan,
  nextHistoryCheckpoint,
  shouldProbeHistoryFloor,
} from './sync-decision'

export class CardanoHistoryError extends Data.TaggedError('CardanoHistoryError')<{
  readonly reason: string
}> {}

/**
 * Either chain error's text.
 *
 * ⚠️ Our port's `ProviderError` carries `reason`; Evolution's carries `message` (with the real
 * cause in a field most re-wrapping drops). During the migration both reach this file, and
 * reading the wrong one yields `undefined` in a log line that exists to say what went wrong.
 */
const chainErrorText = (e: {readonly reason?: string} | {readonly message?: string}): string =>
  'reason' in e && typeof e.reason === 'string'
    ? e.reason
    : 'message' in e && typeof e.message === 'string'
      ? e.message
      : String(e)

/** Map a loosely-typed koios certificate to the structured history cert. */
const mapCert = (cert: EvolutionProvider.IndexedTxCert): IndexedCertificate => {
  const info = (cert.info ?? {}) as Record<string, unknown>
  const str = (k: string): string | undefined => (typeof info[k] === 'string' ? (info[k] as string) : undefined)
  const credHash = str('stake_key_hash') ?? str('credential') ?? str('cred') ?? ''
  const drepFrom = (): ReviewedDRep => {
    const t = str('drep_type') ?? str('type')
    if (t === 'abstain') return {type: 'abstain'}
    if (t === 'no_confidence') return {type: 'no_confidence'}
    const hash = str('drep_id') ?? str('drep') ?? ''
    return t === 'script_hash' ? {type: 'script_hash', scriptHashHex: hash} : {type: 'key_hash', keyHashHex: hash}
  }
  switch (cert.type) {
    case 'stake_registration':
    case 'registration':
      return {kind: 'stake-registration', credentialHashHex: credHash}
    case 'stake_deregistration':
    case 'deregistration':
      return {kind: 'stake-deregistration', credentialHashHex: credHash}
    case 'delegation':
    case 'stake_delegation':
    // Koios's name for a stake→pool delegation, which matched nothing here.
    case 'pool_delegation':
      return {
        kind: 'stake-delegation',
        credentialHashHex: credHash,
        poolKeyHashHex: str('pool_id_hex') ?? str('pool') ?? '',
      }
    case 'vote_delegation':
      return {kind: 'vote-delegation', credentialHashHex: credHash, drep: drepFrom()}
    case 'pool_retirement':
      return {
        kind: 'pool-retirement',
        poolKeyHashHex: str('pool_id_hex') ?? str('pool') ?? '',
        epoch: BigInt(String(info.epoch ?? 0)),
      }
    default:
      return {kind: 'unknown', label: cert.type}
  }
}

/**
 * An asset `unit` back to the pair this app stores.
 *
 * ⚠️ The policy id is the first 56 hex characters and **everything after it is the asset name**,
 * including nothing at all: an empty asset name is a real asset name, and a split that treated it
 * as absent would emit a different asset than the chain holds.
 */
const splitUnit = (unit: string) => ({policyIdHex: unit.slice(0, 56), assetNameHex: unit.slice(56)})

const toIndexedIO = (io: EvolutionProvider.IndexedTxIO): IndexedCardanoTx['inputs'][number] => ({
  addressBech32: EvolutionAddress.toBech32(io.address),
  coin: io.coin,
  tokens: io.assets.map((a) => ({...splitUnit(a.unit), amount: a.quantity})),
  ...(io.outpoint !== undefined
    ? {outpoint: {txHashHex: TransactionHash.toHex(io.outpoint.txHash), index: io.outpoint.index}}
    : {}),
})

/**
 * Evolution's `IndexedTx` → tx-review `IndexedCardanoTx`.
 *
 * ⚠️ **This is an edge: typed in, hex out.** An `IndexedCardanoTx` is persisted in the local tx
 * store and compared against stored rows, so its hex is a storage format rather than an
 * implementation detail — which is why the conversions live here and not deeper in.
 */
const toIndexedCardanoTx = (tx: EvolutionProvider.IndexedTx, networkId: number): IndexedCardanoTx => ({
  hash: TransactionHash.toHex(tx.txHash),
  ...(tx.blockHeight !== undefined ? {blockHeight: tx.blockHeight} : {}),
  ...(tx.slot !== undefined ? {slot: tx.slot} : {}),
  ...(tx.epochNo !== undefined ? {epochNo: tx.epochNo} : {}),
  ...(tx.blockHashHex !== undefined ? {blockHashHex: tx.blockHashHex} : {}),
  ...(tx.blockTime !== undefined ? {time: new Date(tx.blockTime * 1000).toISOString()} : {}),
  fee: tx.fee,
  inputs: tx.inputs.map(toIndexedIO),
  outputs: tx.outputs.map(toIndexedIO),
  certificates: tx.certificates.map(mapCert),
  withdrawals: tx.withdrawals.map((w) => ({rewardAddressBech32: w.stakeAddress, amount: w.amount})),
  mint: tx.mint.map((m) => ({...splitUnit(m.unit), amount: m.quantity})),
  ...(tx.metadata !== undefined ? {metadata: tx.metadata} : {}),
  // ⚠️ No `valid`: `/tx_info` carries no phase-2 verdict, so an indexer summary cannot answer it
  // and asserting `true` would make a script-failed transaction indistinguishable from a
  // successful one. The detail view reads the flag off the transaction's own bytes
  // (`Inspect.isValidFromTx`), which is the only place it exists.
  networkId,
})

const keyOf = (rail: CardanoRail): string =>
  `${rail.dataRef.groupId}:${rail.dataRef.chainId}:${rail.dataRef.accountIndex}`

/**
 * The full historical payment-address set for the wallet group, resolved once
 * from the provider's account-level enumeration and reused by both sync and
 * read so direction is classified over EVERY address, not just the primary.
 * Crucially this is history-based (every address the stake key ever used), so a
 * spent-out (0-balance) wallet still resolves all its addresses — unlike a
 * UTxO-presence scan, which finds nothing on such a wallet. Falls back to the
 * rail's known set when the provider has no account-address surface.
 */
const ownAddressCache = new Map<string, readonly string[]>()

/**
 * Every address we currently believe is ours, for classifying history.
 *
 * The cache is keyed by (group, chain, account) — the same key the primary-only
 * rail uses before discovery has run — so a value cached during that phase must
 * not shadow a rail that has since been rebuilt with the discovered set. Union,
 * never either-or: an address either side knows about is ours, and treating one
 * of our own addresses as foreign is what made a wallet's own output at index 36
 * read as a stranger reusing its staking key.
 */
const ownAddressesFor = (rail: CardanoRail): readonly string[] => [
  ...new Set([...(ownAddressCache.get(keyOf(rail)) ?? []), ...rail.knownAddresses]),
]

/**
 * Record addresses as ours. The set only ever GROWS: an address does not stop
 * being ours because a later, narrower rail did not mention it. The same
 * (group, chain, account) key is used by the primary-only rail that exists
 * before discovery finishes, so a plain `set` here would shrink the set on every
 * mount — which is exactly how the user watched their own address be recognised
 * and then un-recognised a moment later.
 */
const rememberOwnAddresses = (rail: CardanoRail, addresses: readonly string[]): readonly string[] => {
  const merged = [...new Set([...(ownAddressCache.get(keyOf(rail)) ?? []), ...addresses])]
  ownAddressCache.set(keyOf(rail), merged)
  return merged
}

const resolveOwnAddresses = (rail: CardanoRail, reward: string | null): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    // Nothing to enumerate against for a bare address: the wallet is the one address
    // it was given, so the known set is already complete.
    if (reward === null || rail.chain.getAccountAddresses === undefined) {
      return rememberOwnAddresses(rail, rail.knownAddresses)
    }
    const discovered = yield* rail.chain.getAccountAddresses(reward as RewardAddress.RewardAddress).pipe(
      Effect.map((addresses) => addresses.map((a) => EvolutionAddress.toBech32(a)) as readonly string[]),
      Effect.catchAll((e) => {
        logger.warn('Address discovery failed; falling back to the rail known set', {
          origin: 'CardanoHistory',
          knownCount: rail.knownAddresses.length,
          error: String(e),
        })
        return Effect.succeed([] as readonly string[])
      }),
    )
    // Union with the rail's known set so a provider miss never drops the primary.
    return rememberOwnAddresses(rail, [...rail.knownAddresses, ...discovered])
  })

/**
 * Credential inspector for the history producer, memoised per call site.
 *
 * The indexed rows carry bech32 addresses, and every tier past own/other is a
 * credential fact — our escrows, the identity, an address reusing our stake key,
 * and the NIGHT-claim scripts. `@pnyx/tx-review` stays codec-free, so the
 * decode happens here, where the rail already has one. An undecodable address
 * yields `undefined`, which degrades that row to own/other rather than guessing.
 */
const makeCredentialsOf = () => {
  const cache = new Map<string, ReviewedIO['credentials']>()
  return (addressBech32: string): ReviewedIO['credentials'] => {
    const hit = cache.get(addressBech32)
    if (hit !== undefined || cache.has(addressBech32)) return hit
    let credentials: ReviewedIO['credentials']
    // A Byron counterparty carries no credential this app can read, so `undefined`
    // is the answer rather than a failure — and saying so here is what stops one
    // `Ddz…` address in a history row from logging a decode error per pass.
    if (isByronAddress(addressBech32)) {
      cache.set(addressBech32, undefined)
      return undefined
    }
    try {
      const info = Address.inspect(Address.fromBech32Sync(Bech32(addressBech32)))
      const payment =
        info.paymentCredHex === undefined
          ? undefined
          : {hashHex: info.paymentCredHex, type: info.paymentIsScript === true ? ('script' as const) : ('key' as const)}
      const stake =
        info.stakeCredHex === undefined
          ? undefined
          : {hashHex: info.stakeCredHex, type: info.stakeIsScript === true ? ('script' as const) : ('key' as const)}
      credentials =
        payment === undefined && stake === undefined
          ? undefined
          : {...(payment !== undefined ? {payment} : {}), ...(stake !== undefined ? {stake} : {})}
    } catch (e) {
      // The address itself, truncated: without it this line says a row degraded and gives nobody a way
      // to find out which kind of address did it. ⚠️ Byron addresses used to arrive here in bulk and
      // drown this out — they are recognised above now, so anything reaching this branch is a shape
      // we did not expect and worth reading.
      logger.debug('Address did not decode; row degrades to own/other', {
        origin: 'CardanoHistory',
        address: `${addressBech32.slice(0, 12)}…${addressBech32.slice(-6)}`,
        length: addressBech32.length,
        error: String(e),
      })
      credentials = undefined
    }
    cache.set(addressBech32, credentials)
    return credentials
  }
}

const historyContext = (
  rail: CardanoRail,
  ownAddresses: readonly string[],
  rewardBech32: string | null,
): HistoryWalletContext => ({
  /**
   * ⚠️ **Our own CIP-113 smart wallet belongs here, and used to be missing.** It is the deployment's
   * PLB script over our own stake credential, so it is in no address list and no gap scan — and
   * ownership here is set membership, so an output to it was not `own/wallet`, which means
   * `ownDeltaValue` skipped it. A mint of 1,000,000 tokens into our own smart wallet therefore
   * reviewed as a 2.3 ada payment to a stranger, and the token's activity list — which filters on
   * `ownDelta` — was empty while the portfolio showed the balance.
   *
   * `custodyOfAddress` already recognised the address (`protocolScripts` → `script-protocol`); it was
   * only this set that had not been told.
   */
  ownAddressesBech32: new Set(
    [
      ...ownAddresses,
      rewardBech32,
      ownSmartWalletBech32({
        protocolMagic: rail.config.protocolMagic,
        stakeKeyHashHex: rail.account.stakeKeyHashHex,
      }),
    ].filter((a): a is string => a !== null),
  ),
  // Absent for a bare address, which is exactly what the producer expects: with no
  // reward address of ours, no withdrawal in a transaction can be read as our own.
  ...(rewardBech32 === null ? {} : {rewardAddressBech32: rewardBech32}),
  wallet: rail.account.walletContext,
  credentialsOf: makeCredentialsOf(),
})

const PAGE = 1000 // `/address_txs` rows per page (server offset window).

/**
 * How long a single indexer read may take before the walk gives up on it.
 *
 * ⚠️ Neither read was bounded, which is why a timing-out account query presented as a wallet that
 * syncs forever rather than as an error. The probe's is short because it only feeds an optimisation;
 * a page's is long because deep windows legitimately take tens of seconds — measured at 30.7s three
 * million blocks below the tip.
 */
const PROBE_TIMEOUT = '15 seconds' as const
const PAGE_TIMEOUT = '90 seconds' as const

/**
 * Longer, because this one is asked once per account and what it buys is the whole descent: without a
 * floor the backfill has to walk to block zero through history the account was never part of.
 */
const FLOOR_PROBE_TIMEOUT = '45 seconds' as const

/**
 * How long one run will spend extending a backfill before stopping with its progress recorded.
 *
 * A bound, not a target: a run that keeps going is a sync that never returns, and the point of
 * per-window persistence is that stopping early costs nothing but time.
 */
const BACKFILL_BUDGET_MS = 20_000

/** Backstop on the loop itself, so a planner that stopped descending cannot spin. */
const MAX_WINDOWS_PER_RUN = 64
// ⚠️ Both batches survive the provider learning to split bodies itself, and for reasons that
// are NOT the 5120-byte cap any more:
//   - `INFO_BATCH` is the unit of PERSISTENCE. Each batch is stored as it lands, so an
//     interrupted backfill resumes from the stored-hash set; handing the whole list over would
//     persist nothing until the last request returned.
//   - the ADDRESS batch is the provider's to decide, not ours: `getTxsAt` refuses an `offset`
//     across a split request body, so a batch that does not fit is a walk that returns nothing
//     rather than a slower one. `splitAddressesForTxsAt` is that arithmetic, published by the
//     backend that holds the budget. ⚠️ We held a count here instead — 40, sized against Koios's
//     5120-byte limit rather than the client's own 4096-byte budget — and every window of every
//     refresh was refused in about 7 ms with no request issued.
const INFO_BATCH = 50 // `/tx_info` hashes per request (~50×67B ≈ 3.4KB).
const MAX_REFS = 100_000 // hard ceiling on the walk (runaway safety).

const chunk = <T>(xs: readonly T[], n: number): T[][] => {
  const out: T[][] = []
  for (let i = 0; i < xs.length; i += n) out.push(xs.slice(i, i + n))
  return out
}

/**
 * Sync the wallet's COMPLETE Cardano history into the local store, resumable and
 * incremental. Enumerates every address the stake key ever used (balance-
 * independent), walks all `/address_txs` pages (hash-only, cheap), then fetches
 * `/tx_info` + persists ONLY for hashes not already stored — so the first run
 * backfills everything and later runs cost one page-walk plus details for the
 * genuinely-new txs. Each `tx_info` batch is stored as it lands, so an
 * interrupted backfill resumes from the stored-hash set. Best-effort: a store
 * write never aborts the sync. No-op when the provider lacks a history surface
 * or no store is bound.
 */
/**
 * Wallets whose history walk is running right now.
 *
 * ⚠️ **Sync ticks overlap, and without this they duplicate each other's work.** Observed on a large
 * account: one run started a window at 16:38:43, a second run for the *same* wallet read the checkpoint
 * at 16:39:23 — before the first had written it — and planned the identical window. Deep windows take
 * tens of seconds, so the overlap is the normal case there, not a race that needs bad luck.
 *
 * Deferring rather than sharing the result is deliberate: a walk returns nothing, is idempotent, and
 * runs again on the next tick, so the second caller has nothing to wait for. Same defect class as the
 * duplicated `/account_addresses` reads — see `utils/in-flight.ts` — but the fix a void, periodic job
 * wants is simpler than sharing a promise.
 */
const walking = new Set<string>()

/**
 * ⚠️ An absent `accountIndex` is rendered as `none`, not folded into `0`. They are different refs, and
 * collapsing them would let two wallets share one walk — so one of them would silently never walk.
 */
const walkKey = (ref: {groupId: string; chainId: string; accountIndex?: number | undefined}): string =>
  `${ref.groupId}:${ref.chainId}:${ref.accountIndex === undefined ? 'none' : ref.accountIndex}`

/**
 * How many windows one run may walk.
 *
 * ⚠️ **A user-initiated refresh should not pay for the backfill.** A surface showing three rows wants
 * the newest ones, and the descent is background work — so a caller that is refreshing a widget passes
 * a small budget and gets one window (the incremental one on a caught-up wallet, one step of the
 * descent otherwise) instead of up to {@link MAX_WINDOWS_PER_RUN} deep windows at tens of seconds each.
 */
export type HistorySyncOptions = {readonly maxWindows?: number}

/**
 * What one run of {@link syncCardanoHistory} leaves behind.
 *
 * ⚠️ **`backfillPaused` is the caller's cue to come back.** A run stops at
 * `BACKFILL_BUDGET_MS` with its progress recorded, and until this was reported nothing
 * resumed it: the walk continued only on a rail change or a manual refresh. A wallet whose
 * first transaction is 6.2M blocks below the tip — measured on a mainnet import — needs
 * many runs, so its history appeared a few windows at a time, once per user poke.
 */
export type HistorySyncOutcome = {
  /** The descent stopped on its time budget and is not finished. Run again to continue. */
  readonly backfillPaused: boolean
  /**
   * How many transactions this run persisted that it had never seen.
   *
   * ⚠️ **Evidence the chain moved**, which is the one thing that earns a caller the right to spend
   * the rail's sync throttle: a wallet whose list just gained an incoming payment has a balance
   * that is provably behind the rows rendered next to it. Zero on every early exit, because "we did
   * not look" must not read as "we looked and nothing was there".
   */
  readonly storedNew: number
}

/** Nothing left to do — every early exit reports this, so only a real pause asks to resume. */
const NOT_PAUSED: HistorySyncOutcome = {backfillPaused: false, storedNew: 0}

export const syncCardanoHistory = (
  rail: CardanoRail,
  options: HistorySyncOptions = {},
): Effect.Effect<HistorySyncOutcome, CardanoHistoryError> =>
  Effect.suspend(() => {
    const key = walkKey(rail.dataRef)
    if (walking.has(key)) {
      logger.debug('A history walk is already running for this wallet; this tick defers to it', {
        origin: 'CardanoHistory',
        groupId: rail.dataRef.groupId,
        chainId: rail.dataRef.chainId,
        accountIndex: rail.dataRef.accountIndex,
      })
      // The run that owns the walk reports the pause; this tick must not ask to resume as
      // well, or two loops fight over one wallet.
      return Effect.succeed(NOT_PAUSED)
    }
    walking.add(key)
    return walkHistory(rail, options).pipe(Effect.ensuring(Effect.sync(() => walking.delete(key))))
  })

const walkHistory = (
  rail: CardanoRail,
  options: HistorySyncOptions,
): Effect.Effect<HistorySyncOutcome, CardanoHistoryError> =>
  Effect.gen(function* () {
    const {chain} = rail
    if (chain.getTxsAt === undefined || chain.getTxInfo === undefined) return NOT_PAUSED
    const store = getCardanoDataStore()
    if (store === null) return NOT_PAUSED

    const reward = rail.rewardAddressBech32

    // 0) Cheap change-check FIRST: the stake account's NEWEST tx (one call via
    //    /account_txs) vs the newest we last synced. Unchanged ⇒ the store is
    //    already current, so we skip the ENTIRE walk (no accountAddresses, no
    //    address_txs pages, no tx_info) — steady-state sync is a single call.
    //    (Koios /account_info carries no tx_count, so the newest-hash is the
    //    reliable per-account signal.)
    //    The skip also requires at least one stored row — see `canSkipHistoryWalk`
    //    for why the checkpoint alone cannot be trusted.
    const newestRef =
      chain.getAccountTxs === undefined || reward === null
        ? undefined
        : (yield* chain.getAccountTxs(reward as RewardAddress.RewardAddress, {limit: 1}).pipe(
            // ⚠️ Bounded. On a large account this probe took 9.8s and timed out outright on two of
            // three attempts, and an unbounded failure presents as "syncing forever" rather than as an
            // error. Its only job is the skip optimisation, so giving up on it is cheap — what must
            // *not* happen is the walk being blocked or its progress discarded because it failed.
            Effect.timeoutFail({
              duration: PROBE_TIMEOUT,
              onTimeout: () => new CardanoHistoryError({reason: 'newest-tx probe timed out'}),
            }),
            Effect.catchAll((e) => {
              logger.warn('Newest-tx probe failed; the walk proceeds and still records its progress', {
                origin: 'CardanoHistory',
                error: chainErrorText(e),
              })
              return Effect.succeed([])
            }),
          ))[0]
    // ⚠️ Hex once, here: every use below compares it against a PERSISTED checkpoint hash.
    const newestHash = newestRef === undefined ? undefined : TransactionHash.toHex(newestRef.txHash)
    const checkpoint = yield* store.loadTxCheckpoint(rail.dataRef).pipe(
      Effect.tap((c) =>
        // "Read nothing" and "read something with no floor" plan the same window for different
        // reasons, and neither is visible without this.
        Effect.sync(() =>
          logger.debug('Read the history checkpoint', {
            origin: 'CardanoHistory',
            groupId: rail.dataRef.groupId,
            chainId: rail.dataRef.chainId,
            accountIndex: rail.dataRef.accountIndex,
            present: c !== null,
            oldestEnumeratedHeight: c?.oldestEnumeratedHeight,
            complete: c?.complete,
          }),
        ),
      ),
      Effect.catchAll((e) => {
        logger.warn('Checkpoint read failed; walking the full history', {
          origin: 'CardanoHistory',
          error: String(e),
        })
        return Effect.succeed(null)
      }),
    )
    // One indexed read, unconditionally: both the skip gate and `historyWalkPlan` turn on it, and an
    // incremental plan over an empty table would truncate the history permanently (see that function).
    const hasStoredRows =
      (yield* store.listTxRows({...rail.dataRef, limit: 1}).pipe(
        Effect.catchAll((e) => {
          logger.warn('Stored-rows probe failed; walking the full history', {
            origin: 'CardanoHistory',
            error: String(e),
          })
          return Effect.succeed([])
        }),
      )).length > 0
    if (
      canSkipHistoryWalk({
        newestTxHash: newestHash,
        checkpointTxHash: checkpoint?.txHash,
        hasStoredRows,
        backfillComplete: backfillComplete(checkpoint),
      })
    ) {
      logger.debug('History is already current; skipping the walk', {
        origin: 'CardanoHistory',
        groupId: rail.dataRef.groupId,
        chainId: rail.dataRef.chainId,
        accountIndex: rail.dataRef.accountIndex,
        newestTxHash: newestHash,
        checkpointTxHash: checkpoint?.txHash,
        hasStoredRows,
        complete: checkpoint?.complete,
      })
      return NOT_PAUSED
    }

    const nowMs = Date.now()
    /**
     * The top of the walk.
     *
     * ⚠️ **The chain tip is the fallback that keeps the first window bounded.** On a large account the
     * newest-tx probe times out and a fresh install has no checkpoint either — which left the first
     * window with no bounds at all, i.e. the unbounded enumeration this whole change exists to avoid
     * (measured at 76.7s per page, and that is the shape that never finishes). `/tip` is a global query
     * that does not touch the account, so it answers whatever the account's size.
     */
    const anchorHeight = newestRef?.blockHeight ?? checkpoint?.newestBlockHeight
    const newestTxHeight =
      anchorHeight ??
      (yield* chainTip(chain).pipe(
        Effect.timeoutFail({
          duration: PROBE_TIMEOUT,
          onTimeout: () => new CardanoHistoryError({reason: 'tip read timed out'}),
        }),
        Effect.map((t) => t.blockHeight),
        Effect.catchAll((e) => {
          logger.warn('Tip read failed; the first window has no upper anchor', {
            origin: 'CardanoHistory',
            error: chainErrorText(e),
          })
          return Effect.succeed(undefined)
        }),
      ))

    const ownAddrs = yield* resolveOwnAddresses(rail, reward)
    const ownSet = new Set(reward === null ? ownAddrs : [...ownAddrs, reward])
    /**
     * The same addresses, typed, decoded ONCE for the provider calls.
     *
     * ⚠️ `walkWindow` below is a closure run per window, so the decode that used to sit inside it
     * ran the whole list again on every window. `ownSet` keeps the STRING form on purpose: it is
     * a membership test, and a `Set` of `Address` objects would compare by identity.
     */
    const ownAddrsTyped = ownAddrs.map((a) => EvolutionAddress.fromBech32(a))

    /**
     * A watch of a whole stake account, where the account *is* the wallet.
     *
     * That is the same distinction `accountUtxoMode: 'all'` already draws for balance — "sum every UTxO
     * under the stake key" versus `'owned'`, which drops addresses that merely share the public stake
     * credential. It matters here for two reasons: such an account can have hundreds of thousands of
     * addresses (490,000 for one measured with four funded), and its history has to come from somewhere
     * other than a per-address fanout over a list nobody can hold.
     */
    const wholeAccount = rail.accountUtxoMode === 'all' && reward !== null && chain.getAccountTxs !== undefined

    /**
     * Ownership, decided rather than enumerated when the account is the wallet.
     *
     * ⚠️ **Only for `'all'`.** An address can reuse our stake credential with a payment credential we do
     * not control, and for an ordinary wallet that address is *not* ours — the rail's `'owned'` mode
     * exists to drop exactly those. But a watch of a stake account is a watch of everything delegating
     * to it, which is what the user asked for, so there the credential *is* the answer.
     */
    const credentialsOf = makeCredentialsOf()
    const ourStakeHex = reward === null ? undefined : credentialsOf(reward)?.stake?.hashHex
    const isOwn =
      wholeAccount && ourStakeHex !== undefined
        ? (addressBech32: string): boolean =>
            ownSet.has(addressBech32) || credentialsOf(addressBech32)?.stake?.hashHex === ourStakeHex
        : ownSet

    // 1) Which hashes we already hold, read BEFORE the walk — the walk persists as it
    //    goes now, so reading this afterwards would diff against our own writes.
    const stored = yield* store.listTxRows({...rail.dataRef, limit: MAX_REFS}).pipe(
      Effect.catchAll((e) => {
        logger.warn('Stored-hash read failed; every ref will be re-fetched', {
          origin: 'CardanoHistory',
          error: String(e),
        })
        return Effect.succeed([])
      }),
    )
    const known = new Set(stored.map((s) => s.hash))
    const seen = new Set<string>()
    let fetched = 0

    /**
     * The account's oldest transaction height — the floor a backfill descends to.
     *
     * Asked once and then carried in the checkpoint: it is a fact about history, which does not change.
     *
     * ⚠️ **Asked for every wallet with a reward address, not only a whole-account watch.** The probe is
     * stake-keyed, and it used to be gated on `wholeAccount` alongside the enumeration that shares that
     * query. That conflated two different questions. Enumeration needs `'all'` because an address
     * sharing our stake credential is *not* necessarily ours. A floor does not: every address of ours
     * carries this stake credential in its own bytes, so any transaction of ours is a transaction of
     * this account, and the account's oldest is therefore **at or below** ours. Stopping there can
     * never truncate our history — it is a lower bound, and a conservative one.
     *
     * What the gate cost: a freshly created CIP-1854 shared wallet (rail mode unset, so never `'all'`)
     * got no floor and descended toward genesis. On mainnet that is a walk from the tip through
     * ~13.9M blocks, seconds per window, burning indexer quota — for a wallet holding exactly one
     * transaction, minutes old. Observed as "the balance is annoyingly not syncing".
     */
    const firstTxHeight = yield* !shouldProbeHistoryFloor({
      knownFirstTxHeight: checkpoint?.firstTxHeight,
      hasRewardAddress: reward !== null,
      hasAccountTxs: chain.getAccountTxs !== undefined,
    }) ||
    reward === null ||
    chain.getAccountTxs === undefined
      ? Effect.succeed(undefined)
      : chain.getAccountTxs(reward as RewardAddress.RewardAddress, {order: 'asc', limit: 1}).pipe(
          Effect.timeoutFail({
            duration: FLOOR_PROBE_TIMEOUT,
            onTimeout: () => new CardanoHistoryError({reason: 'oldest-tx probe timed out'}),
          }),
          Effect.map((refs) => refs[0]?.blockHeight),
          Effect.catchAll((e) => {
            // Costs the backfill its floor, so it descends to zero instead — slower, still correct.
            logger.warn('Oldest-tx probe failed; the backfill has no floor to stop at', {
              origin: 'CardanoHistory',
              error: chainErrorText(e),
            })
            return Effect.succeed(undefined)
          }),
        )

    /**
     * Walk one window: page it, fetch and persist details as each page lands, and report what the
     * checkpoint needs to know about it.
     *
     * Paging by `offset` is safe *here* and nowhere else: the window is bounded on both sides, so the
     * set the indexer sorts is small. Offset-paging the whole account is what times out.
     */
    // Bound once, outside the closure: TypeScript discards narrowing of a property access across a
    // function boundary (the object could be mutated in between), so the guard at the top of this
    // function does not survive into `walkWindow`. Re-testing inside would read as a second, weaker
    // condition; binding keeps the one at the top authoritative.
    const accountTxs = chain.getAccountTxs
    const txsAt = chain.getTxsAt
    /**
     * The address batches this provider can serve, asked once.
     *
     * ⚠️ **Absent means unbounded**, which is the backend saying it has no body limit — so the
     * whole list travels as one request. Guessing a count here is what broke the walk.
     */
    const addrBatches: readonly (readonly EvolutionAddress.Address[])[] = chain.splitAddressesForTxsAt?.(
      ownAddrsTyped,
    ) ?? [ownAddrsTyped]
    const txInfo = chain.getTxInfo
    const stakeForWalk = reward
    const walkWindow = (plan: HistoryWalkPlan) =>
      Effect.gen(function* () {
        let maxBlockHeightSeen: number | undefined
        let persistedAll = true
        const addressBatches: readonly (readonly EvolutionAddress.Address[])[] = wholeAccount ? [[]] : addrBatches
        for (const addrBatch of addressBatches) {
          for (let offset = 0; offset < MAX_REFS; offset += PAGE) {
            const pageOpts = {
              offset,
              limit: PAGE,
              ...(plan.afterBlock !== undefined ? {afterBlock: plan.afterBlock} : {}),
              ...(plan.beforeBlock !== undefined ? {beforeBlock: plan.beforeBlock} : {}),
            }
            const page = yield* (
              wholeAccount && stakeForWalk !== null && accountTxs !== undefined
                ? accountTxs(stakeForWalk as RewardAddress.RewardAddress, pageOpts)
                : txsAt(addrBatch, pageOpts)
            ).pipe(
              // Same reasoning as the probe: an unbounded page read presents as a wallet that syncs
              // forever. Failing the window lets everything already persisted stand.
              Effect.timeoutFail({
                duration: PAGE_TIMEOUT,
                onTimeout: () => new CardanoHistoryError({reason: 'history page timed out'}),
              }),
              Effect.mapError((e) => new CardanoHistoryError({reason: chainErrorText(e)})),
            )
            for (const r of page) {
              if (
                r.blockHeight !== undefined &&
                (maxBlockHeightSeen === undefined || r.blockHeight > maxBlockHeightSeen)
              ) {
                maxBlockHeightSeen = r.blockHeight
              }
            }
            // ⚠️ `known` and `seen` are hex because they are compared against PERSISTED rows, and
            // a `Set` cannot be keyed on a `TransactionHash` object — it would compare by identity.
            // The TYPED hash is kept beside its key rather than re-derived: the provider already
            // handed us one, and `getTxInfo` wants one back, so hashing out and parsing back in
            // was an encode and a decode per page that neither side needed.
            const fresh: TransactionHash.TransactionHash[] = []
            for (const r of page) {
              const hex = TxHashHex(TransactionHash.toHex(r.txHash))
              if (known.has(hex) || seen.has(hex)) continue
              seen.add(hex)
              fresh.push(r.txHash)
            }
            for (const hashes of chunk(fresh, INFO_BATCH)) {
              const infos = yield* txInfo(hashes).pipe(
                Effect.mapError((e) => new CardanoHistoryError({reason: chainErrorText(e)})),
              )
              const rows = infos.map((i) =>
                indexedTxToRow(rail.dataRef, toIndexedCardanoTx(i, rail.config.networkId), isOwn),
              )
              if (rows.length > 0)
                yield* store.saveTxRows(rows).pipe(
                  // ⚠️ The indexer has caught up with these, so any pending-activity row for one is
                  // now a duplicate of a real row. Told here, every mounted list settles at once —
                  // without it only a list that happened to re-read cleared, and the home widget span
                  // on a confirmed transaction until the overlay's own timeout.
                  Effect.tap(() =>
                    Effect.sync(() =>
                      resolvePendingActivity(
                        rail,
                        rows.map((r) => r.hash),
                      ),
                    ),
                  ),
                  Effect.catchAll((e) => {
                    // Remembered, not just logged: it is what keeps this window out of
                    // `oldestEnumeratedHeight`, so the next run comes back for it.
                    persistedAll = false
                    logger.warn('Failed to persist a history batch; those txs stay missing', {
                      origin: 'CardanoHistory',
                      rowCount: rows.length,
                      error: String(e),
                    })
                    return Effect.void
                  }),
                )
            }
            fetched += fresh.length
            if (page.length < PAGE) break
          }
        }
        return {maxBlockHeightSeen, persistedAll}
      })

    /**
     * Walk windows until the history is enumerated or the run's budget is spent, persisting after each.
     *
     * ⚠️ **The persistence is the fix.** A large account cannot be enumerated in one run — the deepest
     * windows cost tens of seconds each — so a run that recorded nothing until it finished recorded
     * nothing at all, and every later run started again from the top. Now each window that lands is
     * durable, so the walk is monotonic across runs even when no single run completes it.
     */
    const startedAt = Date.now()
    let paused = false
    let reach: HistoryReach | null | undefined = checkpoint
    // The skip gate compares against this, so a failed probe must not erase it.
    let reachTxHash: string | undefined = checkpoint?.txHash
    let firstSeen = firstTxHeight
    /**
     * ⚠️ **Whether the table holds rows, as the walk makes it true — not as it was before the walk.**
     * `hasStoredRows` is one read taken before the loop, and planning every window against it meant a
     * first sync's second window still saw an empty table: with a checkpoint now carrying `txCount > 0`,
     * that is the `no-stored-rows` case, so it re-planned *the newest window* instead of descending. The
     * run then spent its whole window budget re-walking the window it had just finished.
     */
    let rowsStored = hasStoredRows
    const windowBudget = Math.max(1, Math.min(options.maxWindows ?? MAX_WINDOWS_PER_RUN, MAX_WINDOWS_PER_RUN))
    for (let window = 0; window < windowBudget; window += 1) {
      const plan = historyWalkPlan({checkpoint: reach, hasStoredRows: rowsStored, newestTxHeight, nowMs})
      logger.debug('Walking a history window', {
        origin: 'CardanoHistory',
        // Without these two, two concurrent wallets each on their first window is indistinguishable
        // from one wallet replanning its first window for ever — which is the failure being fixed.
        groupId: rail.dataRef.groupId,
        accountIndex: rail.dataRef.accountIndex,
        reason: plan.reason,
        afterBlock: plan.afterBlock,
        beforeBlock: plan.beforeBlock,
        oldestEnumeratedHeight: reach?.oldestEnumeratedHeight,
        firstTxHeight: firstSeen ?? reach?.firstTxHeight,
      })

      const {maxBlockHeightSeen, persistedAll} = yield* walkWindow(plan)
      // Conservative on a partial failure: claiming fewer rows than there are only costs a replan.
      rowsStored = rowsStored || (persistedAll && fetched > 0)

      const next = nextHistoryCheckpoint({
        previous: reach,
        newestTxHash: newestHash,
        previousTxHash: reachTxHash,
        txCount: stored.length + fetched,
        maxBlockHeightSeen,
        windowFloor: plan.afterBlock,
        firstTxHeight: firstSeen,
        persistedAll,
        wasReconcile: plan.reason === 'reconcile',
        nowMs,
      })
      // Written every window, and never gated on the probe — see `nextHistoryCheckpoint`.
      yield* store.saveTxCheckpoint(rail.dataRef, next).pipe(
        Effect.catchAll((e) => {
          logger.warn('Failed to save the history checkpoint; this window will be walked again', {
            origin: 'CardanoHistory',
            error: String(e),
          })
          return Effect.void
        }),
      )
      // A silent success is as undiagnosable as a silent failure: without this, "the checkpoint is
      // being written" and "the checkpoint write is a no-op" look identical from the outside.
      logger.debug('Recorded a history window', {
        origin: 'CardanoHistory',
        groupId: rail.dataRef.groupId,
        accountIndex: rail.dataRef.accountIndex,
        oldestEnumeratedHeight: next.oldestEnumeratedHeight,
        firstTxHeight: next.firstTxHeight,
        complete: next.complete,
      })
      reach = next
      reachTxHash = next.txHash
      firstSeen = undefined

      // ⚠️ **A window whose writes failed ends the run.** Its floor is deliberately not recorded, so the
      // next run walks it again — but `seen` is per-run and still holds those hashes, so continuing here
      // would skip the very transactions that are missing, and a later window that legitimately writes
      // nothing would then record a floor *below* the hole and call the history complete. Stopping
      // leaves the floor where it was and gives the retry a clean `seen`.
      if (!persistedAll) {
        logger.warn('A window did not persist; stopping this run so the next one re-walks it', {
          origin: 'CardanoHistory',
          afterBlock: plan.afterBlock,
          beforeBlock: plan.beforeBlock,
        })
        break
      }
      // Only a descent continues. `no-stored-rows` is a one-shot re-walk of the newest window, not a
      // step in a descent — looping on it walked the same window until the budget ran out.
      if (plan.reason !== 'backfill' && plan.reason !== 'first-sync') break
      if (backfillComplete(reach)) break
      if (Date.now() - startedAt >= BACKFILL_BUDGET_MS) {
        logger.debug('History backfill paused for this run; progress is recorded', {
          origin: 'CardanoHistory',
          oldestEnumeratedHeight: reach.oldestEnumeratedHeight,
          firstTxHeight: reach.firstTxHeight,
        })
        paused = true
        break
      }
    }
    return {backfillPaused: paused, storedNew: fetched}
  })

/**
 * Read a page of stored history as newest-first `ReviewedTransaction`s. Pure
 * store read (no network beyond the one-shot protocol-params fetch the review
 * needs) — {@link syncCardanoHistory} owns population. `limit`/`offset` page the
 * SQLite read so a whale's full history never lands in JS at once. `[]` when no
 * store is bound.
 */
export const loadCardanoHistory = (
  rail: CardanoRail,
  opts: {readonly limit?: number; readonly offset?: number} = {},
): Effect.Effect<readonly ReviewedTransaction[], CardanoHistoryError> =>
  Effect.gen(function* () {
    const store = getCardanoDataStore()
    if (store === null) return []
    const params = yield* resolveCardanoParams(rail).pipe(
      Effect.mapError((e) => new CardanoHistoryError({reason: e.reason})),
    )
    const reward = rail.rewardAddressBech32
    const ownAddrs = ownAddressesFor(rail)
    const context = historyContext(rail, ownAddrs, reward)

    const items = yield* store
      .listTxRows({
        ...rail.dataRef,
        ...(opts.limit !== undefined ? {limit: opts.limit} : {}),
        ...(opts.offset !== undefined ? {offset: opts.offset} : {}),
      })
      .pipe(
        Effect.catchAll((e) => {
          logger.warn('History page read failed; the list renders empty', {
            origin: 'CardanoHistory',
            error: String(e),
          })
          return Effect.succeed([])
        }),
      )
    const out: ReviewedTransaction[] = []
    for (const it of items) {
      const row = yield* store.getTxRow(rail.dataRef, it.hash).pipe(
        Effect.catchAll((e) => {
          logger.warn('History row read failed; skipping it', {
            origin: 'CardanoHistory',
            hash: it.hash,
            error: String(e),
          })
          return Effect.succeed(null)
        }),
      )
      if (!row?.detailJson) continue
      try {
        out.push(reviewCardanoFromHistory(deserializeIndexedTx(row.detailJson), context, params))
      } catch (e) {
        // A corrupt row is skipped, not fatal — the next sync refills it.
        logger.warn('Skipping a corrupt history row', {origin: 'CardanoHistory', hash: it.hash, error: String(e)})
      }
    }
    return out
  })

/**
 * Re-derive one persisted transaction by hash.
 *
 * The tx-detail screen reads an in-memory by-hash cache primed by whatever the
 * list loaded, which leaves any transaction the session has not paged through —
 * an old row, or any deep link into a cold start — unopenable. The store is the
 * source of truth, so a cache miss reads it here instead of failing. `null` means
 * this wallet genuinely has no such transaction persisted.
 */
export const loadCardanoHistoryTx = (
  rail: CardanoRail,
  hash: string,
): Effect.Effect<ReviewedTransaction | null, CardanoHistoryError> =>
  Effect.gen(function* () {
    const store = getCardanoDataStore()
    if (store === null) return null
    const row = yield* store.getTxRow(rail.dataRef, hash).pipe(
      Effect.catchAll((e) => {
        logger.warn('By-hash history read failed; reporting the tx as absent', {
          origin: 'CardanoHistory',
          hash,
          error: String(e),
        })
        return Effect.succeed(null)
      }),
    )
    if (!row?.detailJson) return null
    const params = yield* resolveCardanoParams(rail).pipe(
      Effect.mapError((e) => new CardanoHistoryError({reason: e.reason})),
    )
    const ownAddrs = ownAddressesFor(rail)
    const context = historyContext(rail, ownAddrs, rail.rewardAddressBech32)
    try {
      return reviewCardanoFromHistory(deserializeIndexedTx(row.detailJson), context, params)
    } catch (e) {
      logger.warn('Stored tx did not re-derive; reporting it as absent', {
        origin: 'CardanoHistory',
        hash,
        error: String(e),
      })
      return null
    }
  })

/**
 * Review any on-chain transaction by hash **from its raw CBOR** — the same
 * decoder the pre-signing review uses.
 *
 * An indexer's structured view is a strict subset of the bytes. Koios returns
 * `voting_procedures` and `proposal_procedures` as empty arrays even for a
 * transaction that provably contains them, flattens Plutus/collateral detail, and
 * omits the witness set; and any certificate type our indexed mapping does not
 * recognise is dropped. The consequence was a review that showed *less* for a
 * settled transaction than for the same transaction before signing: a DRep vote
 * rendered as a bare fee transfer, a four-contract swap showed no Contracts tab.
 *
 * So: bytes for the structure, the indexer only for what bytes cannot give —
 * resolved input addresses and values (a body carries outpoints, not amounts).
 *
 * Nothing is persisted: a foreign transaction is not part of our history, and
 * writing it to the store would corrupt the wallet's own timeline.
 */
export const reviewCardanoTxFromChain = (
  rail: CardanoRail,
  hash: string,
): Effect.Effect<ReviewedTransaction | null, CardanoHistoryError> =>
  Effect.gen(function* () {
    const {chain} = rail
    if (chain.getTxCbor === undefined) return null
    const cbors = yield* chain
      .getTxCbor([TransactionHash.fromHex(hash)])
      .pipe(Effect.mapError((e) => new CardanoHistoryError({reason: chainErrorText(e)})))
    const cborHex = cbors[0]?.cborHex
    if (cborHex === undefined || cborHex.length === 0) return null

    const parts = yield* Effect.all({
      bodyHex: Inspect.txBodyFromTx(cborHex),
      witnessHex: Inspect.witnessSetFromTx(cborHex),
      auxHex: Inspect.auxFromTx(cborHex),
      // The ledger's phase-2 verdict, off the transaction's own bytes. The
      // indexer's summary carries no such field, so this is the only place a
      // script-failed transaction can be distinguished from a successful one.
      isValid: Inspect.isValidFromTx(cborHex),
    }).pipe(Effect.mapError((e) => new CardanoHistoryError({reason: e.message})))

    // Input amounts and addresses are not in the body — only outpoints are — so
    // the indexer still supplies resolution. Absent, inputs degrade to the
    // "foreign inputs" list rather than being silently valued at zero.
    const resolved: ResolvedInput[] = []
    let info: EvolutionProvider.IndexedTx | undefined
    if (chain.getTxInfo !== undefined) {
      const infos = yield* chain.getTxInfo([TransactionHash.fromHex(hash)]).pipe(
        Effect.catchAll((e) => {
          logger.warn('Input resolution failed; inputs degrade to the foreign list', {
            origin: 'CardanoHistory',
            hash,
            error: chainErrorText(e),
          })
          return Effect.succeed([] as readonly EvolutionProvider.IndexedTx[])
        }),
      )
      info = infos[0]
      for (const io of infos[0]?.inputs ?? []) {
        const outpoint = io.outpoint
        if (outpoint === undefined) continue
        // ⚠️ The review matches on raw address bytes, and the provider has already decoded the
        // address — so this reads them off it. It used to re-decode from bech32 through the codec,
        // inside a try/catch for an address that had already parsed once; a decoded address cannot
        // fail to be written back out, so both the round trip and the failure path are gone.
        resolved.push({
          txHashHex: TransactionHash.toHex(outpoint.txHash),
          index: outpoint.index,
          addressHex: EvolutionAddress.toHex(io.address),
          addressBech32: EvolutionAddress.toBech32(io.address),
          coin: io.coin,
          tokens: io.assets.map((t) => ({...splitUnit(t.unit), amount: t.quantity})),
        })
      }
    }

    const params = yield* resolveCardanoParams(rail).pipe(
      Effect.mapError((e) => new CardanoHistoryError({reason: e.reason})),
    )
    const reviewed = yield* reviewCardanoTx(
      parts.bodyHex,
      rail.account.walletContext,
      resolved,
      params,
      parts.witnessHex,
      undefined,
      parts.auxHex,
      witnessLeaksSigningKey(Tx.bodyHash(parts.bodyHex)),
    ).pipe(
      Effect.mapError((e) => new CardanoHistoryError({reason: e.message})),
      Effect.provideService(Decode, rail.decode),
    )
    // The reviewer only ever sees the body, so it reports one. This is the only
    // producer holding the settled transaction, where the body is a slice that
    // can neither verify a signature nor be re-submitted — hand over the whole
    // thing instead.
    //
    // A body also says nothing about where the transaction landed. `info` is the
    // same row the input resolution above came from — its block context was being
    // fetched and dropped, which is why a settled transaction rendered here
    // carried no date, no verdict and no block.
    const block = info === undefined ? undefined : reviewedBlockOf(info)
    return {
      ...reviewed,
      cbor: {hex: cborHex, kind: 'transaction'} as const,
      status: parts.isValid ? ('confirmed' as const) : ('failed' as const),
      ...(info?.blockTime !== undefined ? {timestamp: new Date(info.blockTime * 1000).toISOString()} : {}),
      ...(block !== undefined ? {block} : {}),
    }
  })

/**
 * Review ANY on-chain transaction by hash, fetched from the indexer — including
 * transactions this wallet has nothing to do with.
 *
 * {@link loadCardanoHistoryTx} answers only from what this wallet persisted, so a
 * foreign hash is invisible to it. This fetches instead, and deliberately does
 * NOT persist: someone else's transaction is not part of our history, and writing
 * it into the store would corrupt the wallet's own timeline.
 *
 * The wallet context is still ours, so ownership tiering stays honest — a foreign
 * transaction simply has no "your wallet" party, which is the correct answer
 * rather than a missing one.
 *
 * `null` means the indexer has no such transaction (or cannot answer).
 */
export const fetchCardanoTxByHash = (
  rail: CardanoRail,
  hash: string,
): Effect.Effect<ReviewedTransaction | null, CardanoHistoryError> =>
  Effect.gen(function* () {
    const {chain} = rail
    if (chain.getTxInfo === undefined) return null
    const infos = yield* chain
      .getTxInfo([TransactionHash.fromHex(hash)])
      .pipe(Effect.mapError((e) => new CardanoHistoryError({reason: chainErrorText(e)})))
    const info = infos[0]
    if (info === undefined) return null
    const params = yield* resolveCardanoParams(rail).pipe(
      Effect.mapError((e) => new CardanoHistoryError({reason: e.reason})),
    )
    const context = historyContext(rail, ownAddressesFor(rail), rail.rewardAddressBech32)
    try {
      return reviewCardanoFromHistory(toIndexedCardanoTx(info, rail.config.networkId), context, params)
    } catch (e: unknown) {
      // `null` drops the transaction from Activity, so one we cannot review is missing from the
      // history rather than shown as unreadable.
      logger.warn('Transaction could not be reviewed from history; it is omitted from Activity', {
        origin: 'cardano/history',
        error: String(e),
      })
      return null
    }
  })
