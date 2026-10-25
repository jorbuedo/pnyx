// Shared headless-wallet assembly for the deploy/lifecycle scripts. Mirrors testkit's
// FluentWalletBuilder with two hardening changes learned on Preprod (docs/CONTRACT_RESULTS.md):
// - the shielded section gets a NO-OP sync (its event scan is unbounded and this wallet
//   never holds shielded coins — fees are DUST, signing is the unshielded keystore);
// - the dust sync runs with large batches (the default batch=10 does one WASM state copy
//   per 10 events and collapses under Preprod's >1.2M dust events).
import {
  DustSecretKey,
  LedgerParameters,
  unshieldedToken,
  ZswapSecretKeys,
} from '@midnight-ntwrk/midnight-js-protocol/ledger'
import {MidnightWalletProvider, WalletSeeds} from '@midnight-ntwrk/testkit-js'
import {
  CustomShieldedWallet,
  createKeystore,
  DustWallet,
  InMemoryTransactionHistoryStorage,
  mergeWalletEntries,
  PublicKey,
  UnshieldedWallet,
  WalletEntrySchema,
  WalletFacade,
} from '@midnight-ntwrk/wallet-sdk'
import {makeWasmProvingService} from '@midnight-ntwrk/wallet-sdk-capabilities/proving'
import {V1Builder} from '@midnight-ntwrk/wallet-sdk-shielded/v1'
import type {KeyMaterialProvider} from '@midnight-ntwrk/zkir-v2'
import {Stream} from 'effect'
import * as Rx from 'rxjs'
import {patchNoopDustBalancing} from './balancing.js'
import {loadDustState, storeDustState} from './dust-state.js'
import type {CoinSync} from './submission.js'

export type WalletEnv = {
  readonly walletNetworkId: unknown
  readonly networkId: string
  readonly indexer: string
  readonly indexerWS: string
  readonly node: string
  readonly nodeWS: string
  readonly proofServer: string
  readonly faucet?: string
}

type Progress = {
  isStrictlyComplete(): boolean
  /**
   * Optional because the SDK genuinely leaves these unset early in a sync — observed on the sponsor
   * host 2026-08-15, where reading them unconditionally threw `undefined is not an object` and took
   * the wallet boot down with it. The declared-as-`bigint` version of this type was simply wrong.
   */
  appliedIndex?: bigint
  highestRelevantWalletIndex?: bigint
}
export type FacadeState = {
  unshielded: {
    progress?: Progress
    balances: Record<string, bigint>
    availableCoins: {utxo: {type: string}; meta: {registeredForDustGeneration: boolean}}[]
  }
  dust: {
    /** CoreWallet: `pendingDust` holds own spends not yet observed on-chain by the sync. */
    state: {progress: Progress; pendingDust: unknown[]}
    balance(at: Date): bigint
  }
}

export const nightRaw = (): string => unshieldedToken().raw

export type AssembleWalletOptions = {
  /**
   * Path of a dust-state snapshot (see dust-state.ts). When the file exists the dust
   * section boots via restore() and only syncs the catch-up since the snapshot; when it
   * doesn't, the section cold-syncs from its seed. Save with {@link saveDustState}.
   */
  readonly dustStateFile?: string
  /**
   * Key material for proving the fee balancing **in this process**, instead of at `env.proofServer`.
   *
   * Balancing is a proving path: `balanceTx` adds unproven zswap/dust spend actions, and the facade
   * proves them — through an HTTP proof server by default. Pass a provider (see
   * `prover-keys.ts`) on a host that runs no proof server; leave it out and the proving server URL
   * is used, which is what the local stack and the harness scripts want.
   */
  readonly keyMaterialProvider?: KeyMaterialProvider
}

export const assembleWallet = async (
  logger: unknown,
  env: WalletEnv,
  masterSeed: string,
  options?: AssembleWalletOptions,
) => {
  const keyMaterialProvider = options?.keyMaterialProvider
  const walletConfig = {
    indexerClientConnection: {indexerHttpUrl: env.indexer, indexerWsUrl: env.indexerWS},
    provingServerUrl: new URL(env.proofServer),
    networkId: env.walletNetworkId,
    relayURL: new URL(env.nodeWS),
    txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
    costParameters: {feeBlocksMargin: Number(process.env.CHAIN_FEE_BLOCKS_MARGIN ?? 5)},
    batchUpdates: {size: 10_000, timeout: 500, spacing: 0},
  }
  // `as never` throughout for the dual-package reason documented below: several wallet-sdk types
  // resolve to a different nested copy here, so they are nominally incompatible while being
  // structurally identical at runtime.
  const NoopSyncShieldedWallet = CustomShieldedWallet(
    walletConfig as never,
    new V1Builder().withDefaults().withSync(() => ({updates: () => Stream.never}), (() => ({
      applyUpdate: (state: unknown, _update: unknown) => [state, {changes: [], protocolVersion: 0}],
    })) as never) as never,
  )
  const seeds = WalletSeeds.fromMasterSeed(masterSeed)
  const keystore = createKeystore(seeds.unshielded, env.walletNetworkId as never)
  // The facade and every section come from the TOP-LEVEL wallet-sdk (1.2.x), not
  // testkit's WalletFactory: testkit nests wallet-sdk 1.1.0, whose facade lacks
  // waitForGeneratedDust — code typechecking against the 1.2.x types then throws
  // `facade.waitForGeneratedDust is not a function` at runtime (hit live on Preprod
  // 2026-07-16, first time ensureDust saw an unregistered NIGHT UTXO).
  const facade = await WalletFacade.init({
    configuration: walletConfig as never,
    // Omitted unless asked for, so the default stays the SDK's own server-proving service.
    ...(keyMaterialProvider === undefined ? {} : {provingService: () => makeWasmProvingService({keyMaterialProvider})}),
    shielded: () => NoopSyncShieldedWallet.startWithSeed(seeds.shielded),
    unshielded: () =>
      UnshieldedWallet({
        ...walletConfig,
        txHistoryStorage: new InMemoryTransactionHistoryStorage(WalletEntrySchema, mergeWalletEntries),
      } as never).startWithPublicKey(PublicKey.fromKeyStore(keystore as never)),
    dust: () => createDustSection(logger, walletConfig, seeds.dust, options?.dustStateFile),
  } as never)
  // Zero-fee txs must not carry an empty DustActions intent (node NotNormalized / 117).
  patchNoopDustBalancing(facade as never)
  return MidnightWalletProvider.withWallet(
    logger as never,
    env as never,
    facade as never,
    ZswapSecretKeys.fromSeed(seeds.shielded),
    DustSecretKey.fromSeed(seeds.dust),
    keystore,
  )
}

const createDustSection = (logger: unknown, walletConfig: object, dustSeed: Uint8Array, dustStateFile?: string) => {
  // Dust fees keep the SDK's cost defaults (testkit's DEFAULT_DUST_OPTIONS shape) except
  // additionalFeeOverhead, which MUST be > 0: with a zero-fee-imbalance transaction
  // (idle-chain fees round to 0) the SDK's balancing loop in wallet-sdk-dust-wallet's
  // computeBalancingRecipe selects no coins, then feeds the merged tx's positive fee back
  // into coin selection where an imbalance (negative = deficit) is expected — selecting
  // nothing again, forever, in a synchronous Effect.runSync loop (the ~300% CPU "hang").
  // Any positive overhead makes the initial imbalance a real deficit, so coin selection
  // runs on the first pass and the loop converges immediately; the overage returns as
  // dust change. restore() must also see the configuration the snapshot was produced
  // under.
  const dustConfig = {
    ...walletConfig,
    costParameters: {
      ledgerParams: LedgerParameters.initialParameters(),
      additionalFeeOverhead: 1n,
      feeBlocksMargin: 5,
    },
  }
  const Dust = DustWallet(dustConfig as never)
  if (dustStateFile !== undefined) {
    try {
      const snapshot = loadDustState(dustStateFile)
      if (snapshot !== null) {
        return Dust.restore(snapshot)
      }
    } catch (error) {
      // The snapshot is a pure cache of on-chain history: unreadable/corrupt means
      // cold-sync from the seed, never a boot failure.
      const warn = (logger as {warn?: (message: string) => void}).warn?.bind(logger)
      warn?.(
        `dust-state snapshot at ${dustStateFile} could not be restored (${
          error instanceof Error ? error.message : String(error)
        }); falling back to a full dust sync`,
      )
    }
  }
  return Dust.startWithSeed(dustSeed, LedgerParameters.initialParameters().dust)
}

/**
 * Snapshot the dust section's current synced state to `filePath`; the next
 * {@link assembleWallet} with the same `dustStateFile` resumes from it. Call after the
 * sections are synced (a pre-sync snapshot is valid but buys nothing) and again before a
 * graceful shutdown so long-running processes keep the snapshot fresh.
 */
export const saveDustState = async (
  wallet: {wallet: {dust: {serializeState(): Promise<string>}}},
  filePath: string,
): Promise<void> => {
  storeDustState(filePath, await wallet.wallet.dust.serializeState())
}

/**
 * Not exported: the SDK publishes wallet state as an RxJS Observable, and this module is
 * the only one in the repo that has to know it. Handing the Observable out is what let
 * `rxjs` become a direct import in the harness. Snapshot callers take
 * {@link currentFacadeState}; anything needing the stream belongs in here, next to
 * {@link waitForSections}.
 */
const facadeState = (wallet: {wallet: {state(): unknown}}): Rx.Observable<FacadeState> =>
  wallet.wallet.state() as Rx.Observable<FacadeState>

/** The facade's current state, as a Promise. */
export const currentFacadeState = (wallet: {wallet: {state(): unknown}}): Promise<FacadeState> =>
  Rx.firstValueFrom(facadeState(wallet))

/** Wait until the unshielded + dust sections are synced (shielded is no-op'd). */
export const waitForSections = (
  wallet: {wallet: {state(): unknown}},
  timeoutMs: number,
  onTick?: (state: FacadeState) => void,
): Promise<FacadeState> =>
  Rx.firstValueFrom(
    facadeState(wallet).pipe(
      Rx.throttleTime(5_000, undefined, {leading: true, trailing: true}),
      Rx.tap((s) => onTick?.(s)),
      Rx.filter(
        (s) => s.unshielded.progress?.isStrictlyComplete() === true && s.dust.state.progress.isStrictlyComplete(),
      ),
      Rx.timeout({each: timeoutMs, with: () => Rx.throwError(() => new Error(`section sync timeout ${timeoutMs}ms`))}),
    ),
  )

/**
 * Coin-observation signal for the transaction queue. Fees are DUST; every locally-built
 * spend parks the consumed coin in the dust wallet's `pendingDust` until the indexer sync
 * ingests the corresponding on-chain event (which also anchors the successor coin's
 * mtIndex in the commitment tree). Building the next transaction while `pendingDust` is
 * non-empty risks a `1010: Invalid Transaction` rejection (DustDoubleSpend, custom 196).
 * NOTE: sync-progress indexes are NOT usable here — dust generation advances them every
 * block whether or not our own spend was observed (learned live 2026-07-05).
 */
export const walletCoinSync = (wallet: {wallet: {state(): unknown}}): CoinSync => {
  const pendingDrained = async (timeoutMs: number): Promise<void> => {
    await Rx.firstValueFrom(
      facadeState(wallet).pipe(
        Rx.filter((s) => s.dust.state.pendingDust.length === 0),
        Rx.timeout({
          each: timeoutMs,
          with: () => Rx.throwError(() => new Error(`own-spend observation timeout ${timeoutMs}ms`)),
        }),
      ),
    )
  }
  return {
    waitForOwnSpends: pendingDrained,
    resync: async (timeoutMs) => {
      await waitForSections(wallet, timeoutMs)
      await pendingDrained(timeoutMs)
    },
  }
}

/** Register unregistered NIGHT UTXOs for dust generation, then wait for DUST to accrue. */
export const ensureDust = async (
  wallet: {
    wallet: {
      state(): unknown
      estimateRegistration(coins: unknown[]): Promise<{fee: bigint}>
      waitForGeneratedDust(coins: unknown[], requiredAmount: bigint, opts?: {timeoutMs?: number}): Promise<void>
      registerNightUtxosForDustGeneration(
        coins: unknown[],
        pk: unknown,
        sign: (p: Uint8Array) => unknown,
      ): Promise<unknown>
      finalizeRecipe(recipe: unknown): Promise<unknown>
      submitTransaction(tx: unknown): Promise<string>
    }
    unshieldedKeystore: {getPublicKey(): unknown; signData(p: Uint8Array): unknown}
  },
  log: (message: string) => void,
): Promise<void> => {
  let state = await currentFacadeState(wallet)
  const unregistered = state.unshielded.availableCoins.filter(
    (coin) => coin.utxo.type === nightRaw() && coin.meta.registeredForDustGeneration === false,
  )
  if (unregistered.length > 0) {
    // The registration pays its own fee from the dust its NIGHT projects to generate;
    // submitting before the projection covers the fee fails the SDK's fee-coverage guard.
    const {fee} = await wallet.wallet.estimateRegistration(unregistered)
    log(`Waiting for projected dust on ${unregistered.length} NIGHT UTXO(s) to cover the registration fee (${fee})…`)
    await wallet.wallet.waitForGeneratedDust(unregistered, fee, {timeoutMs: 600_000})
    log(`Registering ${unregistered.length} NIGHT UTXO(s) for dust generation…`)
    const recipe = await wallet.wallet.registerNightUtxosForDustGeneration(
      unregistered,
      wallet.unshieldedKeystore.getPublicKey(),
      (payload) => wallet.unshieldedKeystore.signData(payload),
    )
    const finalized = await wallet.wallet.finalizeRecipe(recipe)
    log(`Dust registration tx: ${await wallet.wallet.submitTransaction(finalized)}`)
  }
  while (state.dust.balance(new Date()) === 0n) {
    log('Waiting for DUST to generate from registered NIGHT…')
    await new Promise((resolve) => setTimeout(resolve, 10_000))
    state = await currentFacadeState(wallet)
  }
  log(`DUST balance: ${state.dust.balance(new Date())}`)
}
