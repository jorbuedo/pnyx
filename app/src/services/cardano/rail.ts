/**
 * The per-group Cardano rail: chain access (first-party Koios provider),
 * confirmed UTxO state, and the pending-tx overlay that makes tx chaining
 * safe (locked inputs, spendable unconfirmed change).
 *
 * Reconciliation contract (`sync`): full UTxO refetch, then each pending tx is
 * confirmed when its own change appears in the confirmed set, or — for txs
 * with no own change — when every real (non-virtual) input it consumed has
 * vanished from the confirmed set. Unconfirmable entries eventually expire via
 * the tracker's sweep (dropped from the mempool → inputs reappear spendable).
 *
 * @module
 */

import {
  Address as EvolutionAddress,
  Provider as EvolutionProvider,
  Transaction as EvolutionTransaction,
  KeyHash,
  RewardAddress,
  TransactionHash,
  type UTxO,
} from '@evolution-sdk/evolution'
import * as Plan from '@evolution-sdk/plan/Plan'
import {Bech32} from '@evolution-sdk/review/Brands'
import {Decode} from '@evolution-sdk/review/Decode'
import {Address} from '@pnyx/cardano-core'
import type {CoreError} from '@pnyx/cardano-core/Op'
import type {ChainId} from '@pnyx/config'
import {
  createPendingTxTracker,
  createUtxoManager,
  type PendingTx,
  type PendingTxTracker,
  projectSpendable,
  type UtxoOverlayEntry,
  utxoId,
  type WalletBalance,
  type WalletGroupId,
} from '@pnyx/wallet'
import {Cause, Effect, Exit, Layer, Option, Ref} from 'effect'
import {logger} from '../../logger'
import {getCardanoAssetsConfig} from '../cardano-assets/config'
import {ensureSteelswapKey} from '../cardano-assets/steelswap-register'
import {cardanoDecodeLayer} from '../cardano-decode-layer'
import {readIdentityCardanoCreds} from '../identity-cardano-creds'
import {type CardanoAccountContext, type CardanoAccountError, cardanoAccountFromAddress} from './account'
import {addressPathsFingerprint, type RailAddressSet, railAddressSetFromRows, stringsFingerprint} from './address-paths'
import {
  buildCardanoSnapshot,
  type CardanoDataRef,
  cardanoDataRef,
  getCardanoDataStore,
  rowToUtxo,
  utxoToRow,
} from './cardano-store'
import {cardanoChainIdFor} from './chain-id'
import {cip113ProtocolScripts, selectCip113Deployment} from './cip113/deployment-selection'
import {type CardanoRailConfig, getCardanoRailConfig, onCardanoNetworkChange} from './config'
import {type CustodyPartition, type CustodyProviders, partitionByCustody} from './custody'
import {installKoiosMeter} from './koios-meter'
import {koiosProviderLayer} from './koios-provider'
import {ensureKoiosToken} from './koios-register'
import {getKoiosToken} from './koios-token'
import {guardSignedTx, type LeakedSigningKeyError} from './leaked-key'
import {cardanoAccountFromSharedWallet} from './multisig/account'
import type {SharedWallet} from './multisig/types'
import {cardanoPendingTxPersistence} from './pending-tx-store'
import {keepOwnedAccountUtxos, ReadOnlyImportError, type ReadOnlyResolution, resolveReadOnlyCardano} from './read-only'
import {canAdvanceWatermark, newestWatermark, type SyncWatermark, watermarkChanged, watermarkOf} from './sync-decision'
import {utxoAddressBech32, utxoAssetMap} from './utxo-view'

export type CardanoRail = {
  readonly config: CardanoRailConfig
  readonly account: CardanoAccountContext
  /** Persisted-store identity (group + Cardano chain-id + account) — the key the
   * rail persists UTxOs/snapshot under and history keys tx-table under. */
  readonly dataRef: CardanoDataRef
  /** Every address the wallet syncs UTxOs + history for (primary + discovered). */
  readonly knownAddresses: readonly string[]
  /**
   * How this rail treats the stake account, when it was built with an account mode at all.
   *
   * `'all'` means **the account is the wallet** — a watch-only import of a stake key, where every
   * address delegating to it is in scope. That is not a detail of balance alone: history uses it to walk
   * the stake-keyed endpoint instead of fanning out over an address list, which for a large account
   * cannot be enumerated at all (490,000 addresses, measured). `'owned'` keeps the ordinary rule, where
   * an address merely sharing our public stake credential is *not* ours.
   */
  readonly accountUtxoMode?: 'all' | 'owned'
  /**
   * The account's reward (stake) address bech32 — the key for account-level Koios
   * lookups. `null` when watching a bare address: there is no account to look up,
   * so every account-level path falls back to the per-address fanout.
   */
  readonly rewardAddressBech32: string | null
  /** The captured decode instance — for adapters composed on top. */
  readonly decode: Decode
  /**
   * Broadcast a signed transaction, gated: one whose witnesses provably leak their signing keys
   * is refused here rather than sent.
   *
   * ⚠️ **The only broadcast in the app, which is what makes the gate unbypassable.** It is NOT
   * on {@link chain} — Evolution's `submitTx` is deliberately omitted from that type, so a
   * caller cannot reach past the check by taking the typed client instead. Adding a second
   * submit path anywhere is how the gate stops being one.
   *
   * Takes and answers hex: the bytes come from the signing ceremony and the id goes into the
   * pending overlay and the activity list, so both ends of this are a serialization format
   * rather than a value to decode.
   */
  readonly submit: (
    signedTxHex: string,
  ) => Effect.Effect<string, EvolutionProvider.ProviderError | LeakedSigningKeyError>
  /**
   * Chain access, in Evolution's own types. Every read in the app goes through this.
   *
   * ⚠️ **`submitTx` is deliberately omitted.** Broadcast is {@link submit}, which runs the
   * leaked-key check first; exposing the client's own submit here would be a second path past
   * it. That omission is the gate's enforcement, not a tidiness preference.
   */
  readonly chain: Omit<EvolutionProvider.ProviderEffect, 'submitTx'>
  /**
   * The protocol parameters the plan engine builds against.
   *
   * ⚠️ **Here rather than on `provider`, and still exactly one conversion.** The plan engine's
   * `ProtocolParams` is not the chain client's shape — theirs are `number` where the fee
   * arithmetic needs `bigint`, and the execution prices are doubles where these are exact
   * fractions — so `plan` owns the adapter and this is its one call site in the app.
   * Converting at each of the twenty-four readers instead would be the same work twenty-four
   * times, with twenty-four chances to round a price into an under-paid fee.
   *
   * Reads are cheap: the Koios client caches a parameter set for well under an epoch, so a
   * screen that asks per render costs one request per window rather than one per ask.
   */
  readonly protocolParams: Effect.Effect<Plan.ProtocolParams, EvolutionProvider.ProviderError>
  readonly pendingTracker: PendingTxTracker
  /** Confirmed UTxOs as last synced. */
  readonly confirmedUtxos: Effect.Effect<readonly UTxO.UTxO[]>
  /** Confirmed − locked + virtual pending change (the buildable set). */
  readonly spendableUtxos: Effect.Effect<readonly UTxO.UTxO[]>
  readonly balance: Effect.Effect<WalletBalance>
  /**
   * Balance over `spendableUtxos` with unconfirmed overlay entries layered on —
   * the Send compose queue's view. Always UTxO-summed, never the account-level
   * `controlledBalance`, which cannot know about locally queued spends.
   */
  readonly composeBalance: (entries: readonly UtxoOverlayEntry[]) => Effect.Effect<WalletBalance>
  /** Refetch, reconcile pending txs, sweep stale entries. */
  readonly sync: Effect.Effect<void, Error>
  /**
   * Drop the sync throttle, so the next {@link sync} really refetches.
   *
   * ⚠️ **For a caller that has evidence the chain moved, never for a caller that would like it to
   * have.** The throttle exists because every rail endpoint is rate-limited and a screen mount is
   * not news; spending it on a hunch is how the 429s come back. The one caller today is the history
   * walk, which invokes this only when it stored a transaction it had never seen — at which point a
   * balance built from the pre-throttle snapshot is known to be behind the list rendered beside it.
   */
  readonly invalidateSyncThrottle: Effect.Effect<void>
  /** Submit a signed tx and register it in the pending overlay. */
  readonly submitAndTrack: (
    signedTxHex: string,
    tracked: {readonly consumedUtxoIds: readonly string[]; readonly change: readonly UTxO.UTxO[]},
  ) => Effect.Effect<string, EvolutionProvider.ProviderError | LeakedSigningKeyError>
}

/**
 * The CIP-113 PLB credentials to recognise on a network, or none when no deployment is shipped for
 * it — which is the normal case for most networks and must not read as an error.
 */
const cip113ScriptsFor = (protocolMagic: number): CustodyProviders['protocolScripts'] => {
  const selection = selectCip113Deployment({protocolMagic})
  if (selection.kind === 'misconfigured') {
    // Not silent: the feature is meant to be on here and is not, which is an operator's problem.
    logger.warn('cardano: CIP-113 deployment selection is misconfigured', {
      origin: 'createCardanoRail',
      detail: selection.detail,
    })
    return new Map()
  }
  return selection.kind === 'active' ? cip113ProtocolScripts(selection.deployment) : new Map()
}

/** Take the spendable rows, tallying what was held back and why. */
const collectCustody = <T>(partition: CustodyPartition<T>, tally: Map<string, number>): readonly T[] => {
  for (const {custody} of partition.restricted) tally.set(custody.kind, (tally.get(custody.kind) ?? 0) + 1)
  if (partition.foreign.length > 0) tally.set('foreign', (tally.get('foreign') ?? 0) + partition.foreign.length)
  return partition.spendable
}

/**
 * Pending txs the confirmed set proves landed on-chain. Pure — see the module
 * doc for the rule.
 */
export const reconcilePendingTxs = (
  confirmedIds: ReadonlySet<string>,
  pending: readonly PendingTx[],
): readonly string[] => {
  const virtualIds = new Set<string>()
  for (const tx of pending) for (const change of tx.change) virtualIds.add(utxoId(change))
  const confirmed: string[] = []
  for (const tx of pending) {
    if (tx.change.length > 0) {
      if (tx.change.some((change) => confirmedIds.has(utxoId(change)))) confirmed.push(tx.txHash)
      continue
    }
    const realConsumed = tx.consumedUtxoIds.filter((id) => !virtualIds.has(id))
    if (realConsumed.length > 0 && realConsumed.every((id) => !confirmedIds.has(id))) confirmed.push(tx.txHash)
  }
  return confirmed
}

/**
 * One provider layer per (network, endpoint) — **memoized, and that is not an optimisation.**
 *
 * ⚠️ `koiosProvider` holds its epoch-params cache in its own closure (deliberately: a
 * module-global keyed on base URL leaked across Layers and networks in that package's tests).
 * The layer it returns is a `Layer.succeed` over an already-built provider, so the provider — and
 * its cache — is built eagerly when the factory is called. Building a fresh one per call therefore
 * threw the cache away every time, and `protocolParams` re-fetched `/tip` + `/epoch_params` on
 * every transaction build and every watermark probe.
 *
 * Measured on a device (2026-09-08): `tip: 11, epoch_params: 11` inside one 60-second window,
 * 22 of ~50 requests, for data that changes once per epoch (~5 days). The counts move in
 * lockstep because `protocolParams` fetches the tip to learn the epoch before asking for the
 * params, which is the signature of a cache that never hits. It also fills the pacer window, so
 * the waste was slowing the `address_txs` calls the history walk actually needed.
 *
 * Keyed on network *and* URL, so a network switch misses and builds its own rather than serving
 * the other chain's params — the leak the upstream comment warns about. The auth token stays a
 * getter, so a token minted after this layer was built is still picked up.
 */
const railLayers = new Map<string, Layer.Layer<Decode | EvolutionProvider.ProviderEffect>>()

/** The rail's full layer stack: RN-safe decode + the configured first-party provider. */
export const cardanoRailLayer = (config: CardanoRailConfig): Layer.Layer<Decode | EvolutionProvider.ProviderEffect> => {
  const layerKey = `${config.network}|${config.koiosUrl}`
  const memoized = railLayers.get(layerKey)
  if (memoized !== undefined) return memoized
  // Every Koios read in the app is issued through a provider built here, so this is
  // where metering starts. Once per process; see koios-meter.ts for why a 429 was
  // previously impossible to attribute.
  installKoiosMeter()
  const layer = Layer.mergeAll(
    cardanoDecodeLayer,
    // Authenticated-tier bearer token (stored per-identity registration, else the dev env
    // fallback) — lifts the Koios rate limit.
    koiosProviderLayer(config.network, config.koiosUrl, () => getKoiosToken(config.network)),
  )
  railLayers.set(layerKey, layer)
  return layer
}

/** Drop the memoized layers. For tests, and for a config change that is not a network switch. */
export const clearCardanoRailLayers = (): void => {
  railLayers.clear()
}

/**
 * Resolve a watch-only import input (a stake address or any base address) into
 * its reward address + key-credential base-address set, using the configured
 * first-party provider. Rejects with a {@link ReadOnlyImportError} on bad input
 * or when no Cardano endpoint is configured.
 */
export const resolveReadOnlyCardanoImport = async (input: string): Promise<ReadOnlyResolution> => {
  const config = getCardanoRailConfig()
  if (config === null) throw new ReadOnlyImportError({reason: 'unsupported-provider'})
  const net = config.networkId === 1 ? Address.Network.Mainnet : Address.Network.Testnet
  const exit = await Effect.runPromiseExit(
    resolveReadOnlyCardano(net, input).pipe(Effect.provide(cardanoRailLayer(config))),
  )
  if (Exit.isSuccess(exit)) return exit.value
  // Surface the typed failure (not the FiberFailure wrapper) so callers can
  // branch on `.reason`; a defect (die) becomes a generic import error.
  const failure = Cause.failureOption(exit.cause)
  throw Option.getOrElse(failure, () => new ReadOnlyImportError({reason: 'unsupported-provider'}))
}

/**
 * Minimum interval between real Cardano rail syncs. Koios (and every other rail
 * endpoint) is rate-limited, so we don't re-probe/re-fetch on every screen mount
 * or focus — a sync within this window is a no-op (pending-tx sweeps still run).
 * The persisted snapshot + cached balance serve reads in between.
 */
const MIN_SYNC_INTERVAL_MS = 300_000
/** TTL for the cached account-level `account_info` ADA balance read. */
const BALANCE_CACHE_TTL_MS = 300_000

const railCache = new Map<string, Promise<CardanoRail>>()

// The cache key carries the network, so entries can't be mistaken for each
// other — but a rail for the network we just left has nothing left to serve.
onCardanoNetworkChange(() => railCache.clear())

/**
 * Memoized per-(group, address) rail instances — pending-tx state must survive
 * across screens, so every consumer shares one rail. Returns `null` when no
 * first-party endpoint is configured.
 */
/**
 * The wallet's own address book, for the rail being built.
 *
 * ⚠️ **Keyed on the wallet this rail is FOR, never on the selected one.** `groupId` and
 * `accountIndex` are the arguments `getCardanoRail` was called with, and nothing here reads app
 * state — a review opened for wallet X while wallet Y is active must classify X's addresses as
 * X's. The same rule is why `useDappConnector` takes its scope as parameters rather than closing
 * over the selection.
 *
 * ⚠️ **No `branch` filter**: change addresses are the wallet's too, and a rail that knew only the
 * external branch would read its own change as a stranger's.
 *
 * `null` — no store bound, or a read that failed — leaves the caller on the primary address alone,
 * which is the behaviour every caller had before this existed.
 */
export const seedRailAddressSet = async (
  groupId: string,
  chainId: ChainId,
  accountIndex: number,
  primaryBech32: string,
): Promise<RailAddressSet | null> => {
  const store = getCardanoDataStore()
  if (store === null) {
    // Not an error: tests and pre-init have no store. Logged because "no store" and "a read that
    // returned nothing" produce the same primary-only rail, and only one of them is a problem.
    logger.debug('no wallet data store is bound, so this rail knows its primary address alone', {
      origin: 'getCardanoRail',
      groupId,
      accountIndex,
    })
    return null
  }
  try {
    const rows = await Effect.runPromise(
      store.listAddresses({groupId: groupId as WalletGroupId, chainId, accountIndex}),
    )
    return railAddressSetFromRows(rows, primaryBech32)
  } catch (error) {
    logger.warn('the wallet address book could not be read, so this rail knows its primary address alone', {
      origin: 'getCardanoRail',
      groupId,
      accountIndex,
      chainId,
      error: String(error),
    })
    return null
  }
}

export const getCardanoRail = (
  groupId: string,
  addressBech32: string,
  /**
   * The wallet's other addresses.
   *
   * ⚠️ **`undefined` means "read them from the address book", not "there are none".** It was the
   * other way round until 2026-10-09, and five of six callers passed `undefined` — so a dApp was
   * told about forty-one addresses by `getUsedAddresses` and its transaction was then reviewed
   * against a book holding one. A NIGHT redeem paid 81.19 NIGHT to the wallet's own address and
   * the review called it a stake-key hijack and counted it as leaving.
   *
   * Pass `[]` to mean primary-only deliberately; it is a different rail from a seeded one and
   * caches separately.
   */
  extraAddresses: readonly string[] | undefined,
  /**
   * Required, because {@link accountIndex} is. The account is part of the rail's cache identity, so a
   * caller that does not say which account it means cannot be given a correct rail.
   */
  opts: {
    readonly accountUtxoMode?: 'all' | 'owned'
    readonly accountIndex: number
    /** `bech32 → CIP-1852 path`, so the extra addresses can be signed for. */
    readonly addressPaths?: ReadonlyMap<string, string>
  },
): Promise<CardanoRail> | null => {
  const config = getCardanoRailConfig()
  if (config === null) return null
  // Best-effort, once per process: register this identity for its own Koios
  // authenticated tier (own 50k/day) so we don't share the public rate bucket.
  ensureKoiosToken(config, Date.now())
  // Same idea for SteelSwap pricing: mint the identity's CIP-8 durable key so
  // token/ADA prices (NIGHT included) authenticate instead of hitting the dead
  // Turnstile-gated anon path.
  ensureSteelswapKey(getCardanoAssetsConfig(config.network))
  // The discovered set is part of the rail identity: a primary-only rail and a
  // multi-address rail for the same group must not alias in the cache. The
  // account index is part of the identity too — each account is its own rail
  // (own base address, dataRef partition).
  const extra = extraAddresses && extraAddresses.length > 0 ? [...extraAddresses].sort().join(',') : ''
  // ⚠️ A seeded rail and a deliberately-primary-only one both render `extra` as empty, and sharing
  // one cache entry would hand whichever arrived second the other's address scope — the aliasing
  // the comment above exists to prevent.
  const seeding = extraAddresses === undefined
  const mode = opts?.accountUtxoMode
  // Required, not coalesced. The comment above says the account index is part of the rail identity, and
  // defaulting a missing one to 0 is how two accounts' rails alias in the cache — the exact thing that
  // invariant exists to prevent. Every production caller already passed it; only fixtures did not.
  const accountIndex = opts.accountIndex
  // Path coverage is part of the rail identity too: a rail built before the paths
  // were known can recognise its addresses but not sign for them, and reusing it
  // once they ARE known would keep the wallet unable to spend from them.
  //
  // Fingerprinted, not counted: `paths.size` alone made two different address sets of
  // equal size one cache entry, so the second caller was served a rail scoped to the
  // first one's addresses — the same class of bug as aliasing two accounts, and invisible
  // because the rail it got was perfectly functional for somebody else's set.
  const paths = opts?.addressPaths
  const pathPrint = addressPathsFingerprint(paths)
  const key = `${groupId}|${accountIndex}|${addressBech32}|${config.network}|${config.koiosUrl}|${extra}|${seeding ? 'seeded' : ''}|${mode ?? ''}|${pathPrint}`
  const cached = railCache.get(key)
  if (cached) return cached
  const rail = (async (): Promise<CardanoRail> => {
    const seeded = seeding
      ? await seedRailAddressSet(groupId, cardanoChainIdFor(config.network), accountIndex, addressBech32)
      : null
    const addresses = seeding ? (seeded?.beyondPrimary ?? []) : extraAddresses
    const addressPaths = seeding ? seeded?.paths : paths
    return Effect.runPromise(
      makeCardanoRail({
        config,
        groupId,
        addressBech32,
        accountIndex,
        ...(addresses !== undefined && addresses.length > 0 ? {extraAddresses: addresses} : {}),
        ...(addressPaths !== undefined ? {addressPaths} : {}),
        ...(mode ? {accountUtxoMode: mode} : {}),
      }).pipe(Effect.provide(cardanoRailLayer(config))),
    )
  })().catch((error) => {
    railCache.delete(key)
    throw error
  })
  railCache.set(key, rail)
  return rail
}

/**
 * A rail for a CIP-1854 shared wallet at one payment index.
 *
 * Same rail as every other wallet — same provider, same UTxO sync, same
 * persistence — differing only in the account it is given. `extraAddresses`
 * carries the wallet's other discovered script addresses so the sync sees the
 * whole wallet, not just the index being spent from.
 *
 * Cached per (wallet, index) rather than per group: a shared wallet's spending
 * index is part of its rail identity, because the account's signing path and
 * the leaves its authority names both move with it.
 */
export const getSharedWalletRail = (
  wallet: SharedWallet,
  keyIndex: number,
  /**
   * The wallet's other funded indexes. Their addresses join the rail's sync, and
   * their indexes join the account's authority so one transaction can spend them
   * alongside the primary.
   */
  others: readonly {readonly keyIndex: number; readonly addressBech32: string}[] = [],
): Promise<CardanoRail> | null => {
  const config = getCardanoRailConfig()
  if (config === null) return null
  const otherAddresses = others.map((o) => o.addressBech32)
  const extra = otherAddresses.length > 0 ? [...otherAddresses].sort().join(',') : ''
  const key = `shared|${wallet.id}|${keyIndex}|${config.network}|${config.koiosUrl}|${extra}`
  const cached = railCache.get(key)
  if (cached) return cached
  const rail = Effect.runPromise(
    Effect.gen(function* () {
      const account = yield* cardanoAccountFromSharedWallet(
        wallet,
        keyIndex,
        others.map((o) => o.keyIndex),
      )
      return yield* makeCardanoRail({
        config,
        groupId: wallet.id,
        addressBech32: account.addressBech32,
        account,
        accountIndex: wallet.accountIndex,
        ...(otherAddresses.length > 0 ? {extraAddresses: otherAddresses} : {}),
      })
    }).pipe(Effect.provide(cardanoRailLayer(config))),
  ).catch((error) => {
    railCache.delete(key)
    throw error
  })
  railCache.set(key, rail)
  return rail
}

export const disposeCardanoRails = (groupId: string): void => {
  for (const key of [...railCache.keys()]) if (key.startsWith(`${groupId}|`)) railCache.delete(key)
}

export const makeCardanoRail = (params: {
  readonly config: CardanoRailConfig
  /** Wallet group this rail belongs to — the persistence key. `getCardanoRail`
   * always supplies it; direct callers (tests) may omit it and fall back to the
   * address (harmless — persistence is off unless a data store is bound). */
  readonly groupId?: string
  readonly addressBech32: string
  /**
   * A prebuilt account context, for a wallet whose account cannot be derived
   * from a base address — a CIP-1854 shared wallet, whose credentials are script
   * hashes and whose signing paths come from its roster rather than its address.
   * When supplied, `addressBech32` is still the rail's primary address but the
   * account is taken as given.
   */
  readonly account?: CardanoAccountContext
  /** CIP-1852 account index this rail belongs to (default 0). Drives the account
   * context's signing paths + the persisted `dataRef` partition. */
  readonly accountIndex: number
  /** Extra discovered addresses (change/other indices) to sync alongside the primary. */
  readonly extraAddresses?: readonly string[]
  /**
   * `bech32 → CIP-1852 path` for those addresses. Without it they are recognised
   * as ours but cannot be *signed for*, so a send spending one goes out missing a
   * witness — see `cardanoAccountFromAddress`.
   */
  readonly addressPaths?: ReadonlyMap<string, string>
  /**
   * Fetch balance from the account-level UTxO endpoint (`/account_utxos`, keyed
   * on the reward address) instead of a per-address `utxosAt` fanout. Requires a
   * provider that implements `accountUtxos`; otherwise falls back to the fanout.
   *  - `'all'` — sum every UTxO under the stake key (watch-only; the account IS
   *    the wallet). ADA total comes from the atomic `account_info` read.
   *  - `'owned'` — keep only UTxOs on a `knownAddresses` (gap-scanned, verified)
   *    address, dropping foreign addresses that merely share the public stake
   *    credential. Preserves ownership gating for normal wallets while replacing
   *    the N-call per-address fanout with one paginated call.
   */
  readonly accountUtxoMode?: 'all' | 'owned'
}): Effect.Effect<CardanoRail, CardanoAccountError | CoreError, Decode | EvolutionProvider.ProviderEffect> =>
  Effect.gen(function* () {
    const decode = yield* Decode
    const chain = yield* EvolutionProvider.ProviderEffect
    const identityCreds = yield* Effect.promise(() => readIdentityCardanoCreds())
    const account =
      params.account ??
      (yield* cardanoAccountFromAddress(
        Bech32(params.addressBech32),
        params.accountIndex,
        identityCreds,
        (params.extraAddresses ?? []).map(Bech32),
        params.addressPaths ?? new Map(),
      ))
    const rewardAddressBech32 = account.rewardAddressBech32
    const knownAddresses = [
      account.addressBech32,
      ...(params.extraAddresses ?? []).filter((a) => a !== account.addressBech32),
    ]
    /**
     * The same set, typed, decoded ONCE.
     *
     * ⚠️ Not a replacement for `knownAddresses`: that one stays the identity form, because it is
     * compared and used as a `Set` key below, and a `Set` of `Address` OBJECTS would compare by
     * identity and silently match nothing — the defect the UTxO migration found in the witness
     * count. This list exists only for the provider calls, which previously re-decoded every
     * address on every sync and every watermark probe.
     */
    const knownAddressesTyped = knownAddresses.map((a) =>
      a === account.addressBech32 ? account.address : EvolutionAddress.fromBech32(a),
    )
    // Every payment credential this wallet can *sign* with: the primary's, plus each discovered
    // address whose derivation path we know. Recognised-but-unsignable addresses are excluded on
    // purpose — a credential we cannot witness is not one we should be holding UTxOs under.
    const signableAddresses = [account.addressBech32, ...(params.addressPaths?.keys() ?? [])]
    const ownedPaymentCredentials = [
      ...new Set(
        signableAddresses.flatMap((bech32) => {
          const cred = Effect.runSync(
            Effect.try(() => Address.inspect(Address.fromBech32Sync(Bech32(bech32))).paymentCredHex).pipe(
              Effect.orElseSucceed(() => undefined),
            ),
          )
          return cred === undefined ? [] : [cred]
        }),
      ),
    ]
    // A bare-address watch has no account to page, so account level is not a strategy
    // it can use: without this it selected the account path and reported an empty
    // balance for an address holding 122 ADA.
    const useAccountLevel =
      params.accountUtxoMode !== undefined && chain.getAccountUtxos !== undefined && rewardAddressBech32 !== null
    const accountUtxos = chain.getAccountUtxos
    const accountInfoFn = chain.getAccountInfo
    const utxosByCredential = chain.getUtxosByPaymentCredential
    const utxosByCredentials = chain.getUtxosByPaymentCredentials
    /**
     * Ask by payment credential rather than by address.
     *
     * The address-keyed and account-keyed paths can only find UTxOs at addresses we predicted:
     * one enumerates our derived addresses, the other queries the *stake* credential. Neither can
     * see an address pairing our payment key with a stake credential we do not derive — which is
     * what Eternl's multi-delegation feature produces, and which we can spend from perfectly well.
     * There is nothing to enumerate there (the stake half is the counterparty's choice), so the
     * question has to be asked the other way round: what is held under keys we can sign with.
     *
     * Watch-only keeps the account path: it impersonates a whole stake account and has no payment
     * keys of its own, so `'all'` means something this cannot express.
     *
     * **Known limits** (roadmap item 57 in `docs/mobile-shell-plan.md` carries the full list):
     *
     * - `knownAddresses` is still only the derived set, and the history classifier falls back to
     *   it — so transactions at an address found here are missing from Activity and can misread as
     *   "Internal / 0". Balance and spending are unaffected; only history is.
     * - A **first ever** deposit to such an address is not picked up until a full sync runs for
     *   another reason. The watermark probe below covers derived addresses plus ones we already
     *   hold coins at, and a brand-new one is in neither. Closing it needs a credential-level tx
     *   probe (Koios `/credential_txs`), which the provider does not expose.
     * - `cardanoAccountFromAddress` still admits extra addresses by stake-credential equality, so a
     *   multi-delegation address on a **non-primary** payment index is found here but its payment
     *   key is not in the key registry — spendable in principle, unwitnessable in practice.
     * - Staking surfaces speak only for our own stake credential. Nothing over-claims (pinned in
     *   `cardano.test.ts`), but the wallet balance can now exceed what the staking screen accounts
     *   for, and that difference is unexplained on screen.
     */
    const useCredentialLevel =
      params.accountUtxoMode === 'owned' &&
      (utxosByCredentials !== undefined || utxosByCredential !== undefined) &&
      ownedPaymentCredentials.length > 0
    /**
     * ⚠️ **Ask once for the whole set, not once per credential.** A wallet with 611 used
     * addresses has 664 signable credentials, and the per-credential loop below was 664 paced
     * Koios calls every time the rail was built — minutes of a spinner after the gap scan had
     * already finished. The batched provider method answers the same question in ~10.
     *
     * The loop is kept for a provider that cannot batch. It is not a fallback for a *failed*
     * batch: a batch that fails must fail, or a rate-limited answer turns into 664 more requests.
     */
    const fetchByPaymentCredential = (): Effect.Effect<readonly UTxO.UTxO[], EvolutionProvider.ProviderError> =>
      utxosByCredentials !== undefined
        ? utxosByCredentials(ownedPaymentCredentials.map((hex) => KeyHash.fromHex(hex))).pipe(Effect.retry({times: 2}))
        : Effect.forEach(ownedPaymentCredentials, (credentialHex) =>
            (utxosByCredential ?? (() => Effect.succeed([])))(KeyHash.fromHex(credentialHex)).pipe(
              Effect.retry({times: 2}),
            ),
          ).pipe(Effect.map((lists) => lists.flat()))
    // 'owned' mode gates each account UTxO on our verified address set — foreign
    // addresses sharing the public stake credential are dropped. 'all' keeps every
    // UTxO (watch-only impersonates the whole stake account).
    const ownSet = params.accountUtxoMode === 'owned' ? new Set(knownAddresses) : null
    /**
     * The two modes gate on different things, and neither gate does the other's job.
     *
     * `'owned'` compares against the verified derived **address** set. Left alone: it admits
     * addresses we recognise but hold no path for, which a credential-based gate would drop.
     *
     * `'all'` has no such set — the account *is* the wallet — so it used to keep every row,
     * including UTxOs under a script that merely shares our stake key. Those overstated the
     * balance. It now runs the custody engine, which **partitions** rather than filters: the
     * spendable set is byte-identical to what the key-credential filter produced, and what used to
     * be discarded is now classified, so a DEX position or a programmable-token holding can be
     * reported instead of vanishing. See `docs/CARDANO_CUSTODY_MODEL.md`.
     */
    const custodyProviders: CustodyProviders = {
      ownKeyCredentials: new Set(ownedPaymentCredentials.map((c) => c.toLowerCase())),
      // Rosters are not consulted here yet: a shared wallet takes the per-address fanout, never
      // this path, so an empty map is the honest statement rather than a gap.
      sharedWalletScripts: new Map(),
      protocolScripts: cip113ScriptsFor(params.config.protocolMagic),
    }
    const partitionAccountUtxos = (rows: readonly UTxO.UTxO[]) =>
      partitionByCustody(
        rows,
        custodyProviders,
        {sharesOurStake: true, keyOwnership: 'stake-account'},
        utxoAddressBech32,
      )
    // Page the account's UTxO set. Each row carries its owning address, so we
    // filter by `ownSet` (when gating) and label the UTxO.UTxO with its real
    // address (correct for change/coin-selection). A page failure retries then
    // propagates — never break early on error, which would silently truncate the
    // balance (Fallback Value Policy).
    const fetchAccountLevelUtxos = (): Effect.Effect<readonly UTxO.UTxO[], EvolutionProvider.ProviderError> =>
      Effect.gen(function* () {
        if (accountUtxos === undefined || rewardAddressBech32 === null) return []
        const PAGE = 1000
        const out: UTxO.UTxO[] = []
        let excludedRows = 0
        const restrictedByKind = new Map<string, number>()
        let offset = 0
        // Advance by the rows ACTUALLY returned and stop only on an empty page:
        // Koios may return fewer than `limit` rows per page (response-size cap),
        // so breaking on `length < limit` would skip the tail and undercount the
        // balance. Guard caps total pages as a runaway backstop.
        if (rewardAddressBech32 === null) return []
        for (let guard = 0; guard < 1000; guard++) {
          const rawPage = yield* accountUtxos(RewardAddress.RewardAddress.make(rewardAddressBech32), {
            offset,
            limit: PAGE,
          }).pipe(Effect.retry({times: 2}))
          if (rawPage.length === 0) break
          // ⚠️ No conversion: the provider answers Evolution `UTxO`s and the filters read the
          // address off them through `utxoAddressBech32`. This used to map into a wallet shape
          // here, which is the decode the compute zone no longer does.
          const page = rawPage
          const owned =
            ownSet === null
              ? collectCustody(partitionAccountUtxos(page), restrictedByKind)
              : keepOwnedAccountUtxos(page, ownSet, utxoAddressBech32)
          if (owned.length !== page.length) {
            // A user whose balance drops after this shipped is owed an explanation in the log:
            // the coins were never theirs, but the number on screen did change.
            excludedRows += page.length - owned.length
          }
          out.push(...owned)
          offset += page.length
        }
        if (excludedRows > 0) {
          logger.info("cardano: account UTxOs excluded as not this account's", {
            origin: 'createCardanoRail',
            mode: params.accountUtxoMode,
            excludedRows,
            // By custody rather than a bare count: "3 excluded" cannot tell an escrow from a
            // programmable-token holding, and those need different answers on screen.
            byCustody: Object.fromEntries(restrictedByKind),
            keptRows: out.length,
          })
        }
        return out
      })
    // Persisted when the rail knows which wallet it belongs to. Without a group there is no key to
    // store under, and an unpersisted tracker is the behaviour this replaces rather than a new fault.
    const pendingTracker = yield* createPendingTxTracker(
      params.groupId === undefined ? undefined : cardanoPendingTxPersistence(params.groupId, params.addressBech32),
    )
    /**
     * Which question this rail asks the chain for its UTxOs. Named here, beside the branch that
     * picks it, so a log line cannot describe a strategy other than the one in use.
     */
    const fetchStrategy: 'credential' | 'account' | 'address-fanout' = useCredentialLevel
      ? 'credential'
      : useAccountLevel
        ? 'account'
        : 'address-fanout'
    const utxoManager = yield* createUtxoManager({
      chainId: 'cardano',
      fetchUtxos: useCredentialLevel
        ? () => fetchByPaymentCredential()
        : useAccountLevel
          ? () => fetchAccountLevelUtxos()
          : () =>
              Effect.forEach(knownAddressesTyped, (addr) => chain.getUtxos(addr)).pipe(
                Effect.map((lists) => lists.flat()),
              ),
    })

    const confirmedUtxos = utxoManager.getUtxos()
    const spendableUtxos = Effect.flatMap(confirmedUtxos, (confirmed) => pendingTracker.spendableView(confirmed))

    const sumUtxoBalance = (utxos: readonly UTxO.UTxO[]): WalletBalance => {
      let lovelace = 0n
      const assets = new Map<string, bigint>()
      for (const utxo of utxos) {
        lovelace += utxo.assets.lovelace
        for (const [id, quantity] of utxoAssetMap(utxo)) assets.set(id, (assets.get(id) ?? 0n) + quantity)
      }
      return {
        primary: {id: '.', quantity: lovelace},
        secondary: [...assets.entries()].map(([id, quantity]) => ({id, quantity})),
      }
    }

    // Account-level balance: take the ADA total from a single atomic
    // `account_info` read (consistent even while a high-churn account moves funds
    // mid-pagination) and the asset breakdown from the UTxO set. The account_info
    // read is TTL-cached so repeated balance reads (cached-first paint, re-mounts)
    // don't re-hit the rate-limited endpoint. Falls back to the UTxO-summed ADA
    // when the backend doesn't report a controlled balance.
    const controlledBalanceRef = yield* Ref.make<{readonly at: number; readonly value: bigint | null} | null>(null)
    const balance: Effect.Effect<WalletBalance> =
      params.accountUtxoMode === 'all' && accountInfoFn !== undefined && rewardAddressBech32 !== null
        ? Effect.gen(function* () {
            const base = sumUtxoBalance(yield* spendableUtxos)
            const nowMs = Date.now()
            const cached = yield* Ref.get(controlledBalanceRef)
            let controlled = cached !== null && nowMs - cached.at < BALANCE_CACHE_TTL_MS ? cached.value : undefined
            if (controlled === undefined) {
              const info = yield* accountInfoFn(RewardAddress.RewardAddress.make(rewardAddressBech32)).pipe(
                Effect.catchAll((e) => {
                  logger.warn('cardano: account_info read failed; ADA falls back to the UTxO sum', {
                    origin: 'createCardanoRail',
                    error: String(e),
                  })
                  return Effect.succeed(null)
                }),
              )
              // `undefined` is "the backend did not report it", which the cache stores as null.
              controlled = info?.controlledBalance ?? null
              yield* Ref.set(controlledBalanceRef, {at: nowMs, value: controlled})
            }
            return controlled != null ? {...base, primary: {id: '.', quantity: controlled}} : base
          })
        : Effect.map(spendableUtxos, sumUtxoBalance)

    const composeBalance = (entries: readonly UtxoOverlayEntry[]): Effect.Effect<WalletBalance> =>
      Effect.map(spendableUtxos, (base) => sumUtxoBalance(projectSpendable(base, entries)))

    // Watermark of the last full sync — the newest tx across `knownAddresses`.
    // Gates the UTxO refetch: an unchanged newest tx means the confirmed set is
    // unchanged, so repeated `sync` calls (every screen mount/focus) skip the
    // multi-address `utxosAt` fanout.
    const watermarkRef = yield* Ref.make<SyncWatermark>(null)
    // What this rail's UTxO fetch actually covers. Persisted with the watermark so a later
    // rail can tell whether that watermark speaks for its own address set.
    const addressCoverage = stringsFingerprint(knownAddresses)
    // Last real sync (ms) — gates the whole sync to `MIN_SYNC_INTERVAL_MS` so we
    // don't re-hit rate-limited endpoints on every mount/focus.
    const lastSyncAtRef = yield* Ref.make<number>(0)

    // Storage-first: when a data store is bound (app runtime; unset in tests →
    // in-memory only), hydrate the confirmed set + watermark from `@pnyx/store`
    // so a cold start renders offline and its first sync is watermark-gated too.
    const dataStore = getCardanoDataStore()
    const dataRef = cardanoDataRef(
      params.groupId ?? params.addressBech32,
      cardanoChainIdFor(params.config.network),
      params.accountIndex,
    )
    if (dataStore) {
      const rows = yield* dataStore.listUtxos(dataRef).pipe(
        Effect.catchAll((e) => {
          logger.warn('cardano: stored UTxO hydrate failed; starting from an empty set', {
            origin: 'createCardanoRail',
            error: String(e),
          })
          return Effect.succeed([])
        }),
      )
      if (rows.length > 0) {
        const seeded = new Map(
          rows.map((r) => {
            const u = rowToUtxo(r)
            return [utxoId(u), u] as const
          }),
        )
        yield* Ref.set(utxoManager.utxos, seeded)
      }
      const snapshot = yield* dataStore.loadSnapshot(dataRef).pipe(
        Effect.catchAll((e) => {
          logger.warn('cardano: snapshot hydrate failed; the first sync will refetch in full', {
            origin: 'createCardanoRail',
            error: String(e),
          })
          return Effect.succeed(null)
        }),
      )
      // ⚠️ **A watermark is only valid for the address set that produced it.** It asserts
      // "everything up to this transaction has been fetched", which widening the set makes
      // false without moving the newest transaction — so `watermarkChanged` reads "nothing
      // to do" and the newly covered addresses are never fetched at all. That is how a
      // freshly imported wallet showed a claim in its history while the output that claim
      // paid to a non-primary address stayed missing from the balance: the primary-only
      // rail synced first, took in the one output it covered, and advanced the watermark to
      // the account's newest transaction. The 69-credential rail then hydrated that
      // watermark and concluded it was current.
      //
      // An absent `syncCoverage` (every snapshot written before this) counts as a mismatch,
      // so the first sync after upgrading refetches once and is correct thereafter.
      if (snapshot?.syncWatermark) {
        if (snapshot.syncCoverage === addressCoverage) {
          yield* Ref.set(watermarkRef, snapshot.syncWatermark)
        } else {
          logger.info('cardano: the stored watermark covers a different address set; refetching in full', {
            origin: 'createCardanoRail',
            addresses: knownAddresses.length,
            stored: snapshot.syncCoverage ?? 'none',
            current: addressCoverage,
          })
        }
      }
    }

    const reconcileConfirmed = Effect.gen(function* () {
      const confirmed = yield* confirmedUtxos
      const confirmedIds = new Set(confirmed.map(utxoId))
      const pending = yield* pendingTracker.pending
      for (const txHash of reconcilePendingTxs(confirmedIds, pending)) {
        yield* pendingTracker.confirm(txHash)
      }
    })

    const sync = Effect.gen(function* () {
      const throttleNow = Date.now()
      const lastSyncAt = yield* Ref.get(lastSyncAtRef)
      if (throttleNow - lastSyncAt < MIN_SYNC_INTERVAL_MS) {
        // Recently synced — serve the persisted snapshot + cached balance rather
        // than re-probing/re-fetching a rate-limited endpoint. Pending-tx sweeps
        // still run so dropped-mempool entries free their inputs.
        //
        // ⚠️ This returned silently, and "nobody asked this rail to sync" then read
        // identically to "it was asked and declined" — the two answers that had to be
        // told apart to diagnose the 2026-09-09 stale-balance reports.
        logger.debug('cardano: sync throttled; the cached UTxO set stands', {
          origin: 'createCardanoRail',
          addresses: knownAddresses.length,
          sinceLastSyncMs: throttleNow - lastSyncAt,
          minIntervalMs: MIN_SYNC_INTERVAL_MS,
        })
        yield* pendingTracker.sweep(throttleNow)
        return
      }
      yield* Ref.set(lastSyncAtRef, throttleNow)
      const prev = yield* Ref.get(watermarkRef)
      // Probe the newest tx (1 row) when the provider indexes history; if the
      // probe fails or history isn't indexed, fall back to a full refetch. In
      // account-level mode the primary address may hold no recent activity, so
      // probe the whole stake account (`accountTxs`) instead of `txsAt`.
      //
      // The `txsAt` probe is one call however many addresses it carries: the provider
      // splits the body by serialized length and merges the pages, newest first, with a
      // deterministic tie-break. ⚠️ This used to be batched HERE, by a count of 40, because
      // one POST carrying every known address exceeded the proxy's body cap on any
      // gap-scanned wallet and the failure was swallowed into `probed: false` — so the
      // cheap probe never once succeeded there and every sync paid for the full refetch it
      // exists to avoid. A failure still falls back to refetching.
      // Addresses we derived, plus any we are currently holding coins at. The second half matters
      // once UTxOs are found by payment credential: a multi-delegation address is not in the
      // derived set, so probing that set alone would report "nothing changed" for a transaction
      // spending from one, and the sync it exists to trigger would be skipped.
      //
      // Residual gap, deliberate: a *first ever* deposit to such an address is invisible here,
      // because we neither derived it nor hold anything at it yet. Closing that needs a
      // credential-level tx probe (Koios `/credential_txs`), which the provider does not expose.
      const probeAddresses = yield* Effect.map(confirmedUtxos, (utxos) =>
        [...new Set([...knownAddresses, ...utxos.map(utxoAddressBech32)])].map((a) => Bech32(a)),
      )
      // ⚠️ Bounded because a large stake account has answered this in ~10 s and timed out
      // outright. The probe exists only to let the sync skip work, so failing it fast and
      // refetching is strictly better than blocking on it.
      const ACCOUNT_WATERMARK_TIMEOUT = '4 seconds'
      /**
       * Every address we derived shares our stake credential, so one `/account_txs`
       * covers the whole derived book. Only what we hold coins at *outside* it — a
       * multi-delegation address, whose stake half is the counterparty's — has to be
       * asked about by address.
       *
       * ⚠️ **That split is the whole optimisation.** Probing the union by address costs
       * one request per body's worth of them: measured at **16 requests every rail build**
       * on a 611-address wallet, for a question one call answers. Splitting it is 1, plus
       * one more only when coins actually sit at a foreign-stake address.
       */
      const derivedSet = new Set(knownAddresses)
      const outsideAccount = probeAddresses.filter((a) => !derivedSet.has(a))
      const byAddress = (addresses: readonly Bech32[]) =>
        chain.getTxsAt === undefined
          ? Effect.succeed<SyncWatermark>(null)
          : chain
              .getTxsAt(
                addresses.map((a) => EvolutionAddress.fromBech32(a)),
                {limit: 1},
              )
              .pipe(Effect.map(watermarkOf))
      const accountProbe = (reward: string) =>
        (chain.getAccountTxs as NonNullable<typeof chain.getAccountTxs>)(RewardAddress.RewardAddress.make(reward), {
          limit: 1,
        }).pipe(
          // ⚠️ Bounded. On a large stake account this probe has taken ~10 s and timed out
          // outright; it only exists to *skip* work, so giving up on it must be cheap.
          Effect.timeout(ACCOUNT_WATERMARK_TIMEOUT),
          Effect.map(watermarkOf),
        )

      const useAccountProbe = chain.getAccountTxs !== undefined && rewardAddressBech32 !== null
      const probe = useAccountProbe
        ? yield* Effect.all([
            accountProbe(rewardAddressBech32 as string),
            outsideAccount.length === 0 ? Effect.succeed<SyncWatermark>(null) : byAddress(outsideAccount),
          ]).pipe(
            Effect.map(([account, outside]) => ({
              probed: true as const,
              watermark: newestWatermark([account, outside]),
            })),
            Effect.catchAll((e) => {
              logger.warn('cardano: account watermark probe failed; refetching in full', {
                origin: 'createCardanoRail',
                outsideAccount: outsideAccount.length,
                error: String(e),
              })
              return Effect.succeed({probed: false as const})
            }),
          )
        : chain.getTxsAt !== undefined
          ? yield* byAddress(probeAddresses).pipe(
              Effect.map((watermark) => ({probed: true as const, watermark})),
              Effect.catchAll((e) => {
                logger.warn('cardano: address watermark probe failed; refetching in full', {
                  origin: 'createCardanoRail',
                  addressCount: probeAddresses.length,
                  error: String(e),
                })
                return Effect.succeed({probed: false as const})
              }),
            )
          : {probed: false as const}

      const mustFetch = !probe.probed || watermarkChanged(prev, probe.watermark)
      if (!mustFetch) {
        // ⚠️ **The line whose absence cost a device round trip.** A sync that skipped the fetch
        // and one that fetched and found nothing were the same silence, so "the balance is
        // wrong" could not be narrowed to either without adding a log and asking for another
        // run. `credential_utxos` being absent from a `koios-meter` breakdown proves nothing
        // either — that report is capped at the busiest five paths.
        logger.debug('cardano: sync skipped the UTxO fetch; the watermark says nothing changed', {
          origin: 'createCardanoRail',
          strategy: fetchStrategy,
          addresses: knownAddresses.length,
          credentials: ownedPaymentCredentials.length,
        })
      }
      if (mustFetch) {
        const before = new Set((yield* confirmedUtxos).map(utxoId))
        yield* utxoManager.syncFull(probeAddresses)
        yield* reconcileConfirmed
        const after = (yield* confirmedUtxos).map(utxoId)
        const setChanged = after.length !== before.size || after.some((id) => !before.has(id))
        // Which question was asked of the chain, and what came back. Without the strategy a
        // reader cannot tell a credential query from a per-address fanout, and those cover
        // different address sets — which is the whole shape of the cNIGHT bug.
        logger.info('cardano: fetched the confirmed UTxO set', {
          origin: 'createCardanoRail',
          strategy: fetchStrategy,
          addresses: knownAddresses.length,
          credentials: ownedPaymentCredentials.length,
          probeAddresses: probeAddresses.length,
          utxosBefore: before.size,
          utxosAfter: after.length,
          setChanged,
        })
        // Advance the watermark only when the fetch actually absorbed the change
        // the probe reported. The tx index and the UTxO index do not update
        // together, so a probe can see a spend the fetch cannot yet — and a
        // watermark moved past a change we did not take in suppresses every
        // future refetch, freezing the balance until the next transaction.
        if (probe.probed && canAdvanceWatermark({probed: true, previous: prev, setChanged})) {
          yield* Ref.set(watermarkRef, probe.watermark)
        }
        // Persist the fresh confirmed set + watermark (best-effort — a store
        // write must never break sync). Feeds the next cold-start hydrate.
        if (dataStore) {
          const confirmed = yield* confirmedUtxos
          const nextWatermark = yield* Ref.get(watermarkRef)
          yield* dataStore
            .replaceUtxos(
              dataRef,
              confirmed.map((u) => utxoToRow(dataRef, u)),
            )
            .pipe(
              Effect.catchAll((e) => {
                logger.warn('cardano: failed to persist the confirmed UTxO set', {
                  origin: 'createCardanoRail',
                  utxoCount: confirmed.length,
                  error: String(e),
                })
                return Effect.void
              }),
            )
          yield* dataStore.saveSnapshot(buildCardanoSnapshot(dataRef, confirmed, nextWatermark, addressCoverage)).pipe(
            Effect.catchAll((e) => {
              logger.warn('cardano: failed to persist the wallet snapshot', {
                origin: 'createCardanoRail',
                error: String(e),
              })
              return Effect.void
            }),
          )
          yield* dataStore.updateLastSyncAt(dataRef).pipe(
            Effect.catchAll((e) => {
              logger.warn('cardano: failed to record the last-sync time', {
                origin: 'createCardanoRail',
                error: String(e),
              })
              return Effect.void
            }),
          )
        }
      }
      // Time-based expiry runs every sync, gated or not, so dropped-mempool
      // entries free their inputs even when the chain is otherwise idle.
      yield* pendingTracker.sweep(Date.now())
    })

    /**
     * The client handed to callers, with `submitTx` REMOVED — at runtime, not only in the type.
     *
     * ⚠️ `Omit<…, 'submitTx'>` is a type-level claim and nothing more: the object still carried
     * the method, so `(rail.chain as {submitTx})` reached the network with no leaked-key check
     * in front of it. A gate that only the compiler enforces is one an `as` defeats, and this
     * file is the only place that can close it. Destructured out, and the test asserts the
     * absence rather than the type.
     */
    const {submitTx, ...chainReads} = chain

    // Our own signer cannot produce a weak nonce; the gate is insurance against a
    // compromised dependency or a hardware-path regression signing on our behalf.
    //
    // ⚠️ `submitTx` is captured above, which is the one reference to it: callers get
    // `chainReads`, so this is the only route to the network and the guard is unconditionally
    // in front of it.
    const submit: CardanoRail['submit'] = (signedTxHex) =>
      guardSignedTx(signedTxHex).pipe(
        Effect.flatMap(() =>
          Effect.try({
            try: () => EvolutionTransaction.fromCBORHex(signedTxHex),
            catch: (e) =>
              new EvolutionProvider.ProviderError({
                message: `signed transaction did not decode: ${e instanceof Error ? e.message : String(e)}`,
                cause: e,
              }),
          }),
        ),
        Effect.flatMap((tx) => submitTx(tx)),
        Effect.map((hash) => TransactionHash.toHex(hash)),
      )

    const submitAndTrack: CardanoRail['submitAndTrack'] = (signedTxHex, tracked) =>
      Effect.gen(function* () {
        const txHash = yield* submit(signedTxHex)
        yield* pendingTracker.register({
          txHash,
          consumedUtxoIds: tracked.consumedUtxoIds,
          change: tracked.change,
          submittedAt: Date.now(),
        })
        // Let the next sync run immediately (bypass the throttle) so the freshly
        // submitted tx's confirmation is observed promptly.
        yield* Ref.set(lastSyncAtRef, 0)
        return txHash
      })

    return {
      config: params.config,
      account,
      dataRef,
      knownAddresses,
      protocolParams: Effect.map(chain.getProtocolParameters(), Plan.paramsFromProtocolParameters),
      ...(params.accountUtxoMode !== undefined ? {accountUtxoMode: params.accountUtxoMode} : {}),
      rewardAddressBech32,
      decode,
      submit,
      chain: chainReads,
      pendingTracker,
      confirmedUtxos,
      spendableUtxos,
      balance,
      composeBalance,
      sync,
      invalidateSyncThrottle: Ref.set(lastSyncAtRef, 0),
      submitAndTrack,
    } satisfies CardanoRail
  })
