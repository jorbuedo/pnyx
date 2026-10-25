// A sponsor wallet that only balances and submits — no contract, no artifacts, no proving.
//
// `createChainClient` is one constructor that does everything, so it requires `managedDir` and
// `contractModulePath` (the gitignored `compactc` output, ~41 MB) even for a caller that never proves.
// That put a per-deployment build artifact on the sponsor host, where a stale copy would only surface
// as a node rejection — and it made the box's contents depend on which contract is deployed.
//
// `balanceAndSubmitProven` needs exactly three provider methods: `balanceTx`, `submitTx`,
// `watchForTxData`. It never reads the contract module or the ZK config. So this client drops both, and
// the sponsor host's entire runtime becomes a wallet, a seed and a dust-state file — nothing built,
// nothing per-contract, nothing to keep in sync when the contract is redeployed.
//
// What it keeps, deliberately: the FIFO queue and the guarded submitter. Concurrent submissions from one
// wallet produce a coin race (`DustDoubleSpend`) rather than two landed transactions, and 1010-class
// rejections need a wallet resync before a retry — that behaviour is the load-bearing part of the
// original client and is not reimplemented here, only reused.

import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {Transaction} from '@midnight-ntwrk/midnight-js-protocol/ledger'
import {createDefaultTestLogger, initializeMidnightProviders} from '@midnight-ntwrk/testkit-js'
import {sha256} from '@noble/hashes/sha2.js'
import {networkDefaults, walletNetworkIdFor} from './client.js'
import {foreignBalancingProvider} from './foreign-balancing.js'
import {PROVEN_TX_MARKERS} from './proven.js'
import {directoryKeyMaterialProvider} from './prover-keys.js'
import {
  type ContractKind,
  contractCodeDigest,
  createTxDeduplicator,
  decodeSponsoredTx,
  SPONSORED_CIRCLE_ENTRY_POINTS,
  SPONSORED_HANDLE_ENTRY_POINTS,
  SPONSORED_IDENTITY_ENTRY_POINTS,
  SPONSORED_PAYMENT_ENTRY_POINTS,
  SPONSORED_PROPOSAL_ENTRY_POINTS,
  SPONSORSHIP_REFUSAL_PREFIX,
  sponsorshipRefusal,
} from './sponsorship.js'
import {createTxSubmitter, type SubmitRetryOptions} from './submission.js'
import {balanceAndSubmitProven} from './submit-proven.js'
import {
  assembleWallet,
  currentFacadeState,
  ensureDust,
  type FacadeState,
  nightRaw,
  saveDustState,
  waitForSections,
  walletCoinSync,
} from './wallet.js'

export type SponsorClientOptions = {
  /** BIP-39-derived seed for the sponsor wallet. The only secret this host holds. */
  readonly seed: string
  readonly network?: 'undeployed' | 'preprod' | 'mainnet' | (string & {})
  readonly indexer?: string
  readonly indexerWS?: string
  readonly node?: string
  readonly nodeWS?: string
  /** Proof server for the fee balancing. Ignored when {@link SponsorClientOptions.proverKeysDir} is set. */
  readonly proofServer?: string
  /**
   * Where the dust-sync snapshot lives. Strongly recommended: a preprod cold sync walks >1.2M dust
   * events (~15 min), and a snapshot boot replays only the catch-up.
   */
  readonly dustStateFile?: string
  readonly retry?: SubmitRetryOptions
  readonly log?: (message: string) => void
  /**
   * `identity.compact`'s code digest — what recognises an identity contract without knowing its address.
   *
   * ⚠️ Was `identityContract`, an address, on the premise that there was exactly one identity contract.
   * There is one per identity now, at an address derived from `C`, so an address could only have funded
   * a single person. Same shape and same source as {@link circleCodeDigest}: 64 hex characters, and the
   * `codeDigest` the artifacts manifest publishes for the build the devices prove against.
   */
  readonly identityCodeDigest?: string
  /**
   * `payment.compact`'s code digest — the permit contract. Recognised by code rather than by its single
   * address, because adding a circuit moves that address and this one has already moved once.
   */
  readonly paymentCodeDigest?: string
  /** `handle.compact`'s code digest — one contract per claimed name, so there is no address to list. */
  readonly handleCodeDigest?: string
  /**
   * `circle.compact`'s code digest — what recognises a circle without knowing its address.
   *
   * Circles are one contract each, deployed to an address derived from arguments this host never sees,
   * so there is no list to configure. Their `operations` map carries the compiled verifier keys, and
   * hashing those gives the digest the artifact service publishes for the same build
   * (`GET /chain/artifacts/circle` → `codeDigest`). Also 64 hex characters, and also a fact about the
   * *template* rather than a deployment — so a circle deployed tomorrow is recognised by a value
   * configured today, and a redeploy still needs nothing changed here.
   *
   * Either option omitted → every submission of that kind is refused, because a sponsor that will pay
   * for anything is the thing these options exist to prevent.
   */
  readonly circleCodeDigest?: string
  /**
   * `proposal.compact`'s code digest — one contract per proposal, recognised the same way a circle is.
   *
   * Omitted → proposal deploys and votes are refused, which is the honest state for a deployment that
   * has not published proposal artifacts. It is a *separate* value from the circle's: the two are
   * different contracts compiled from different sources, and listing a vote under the circle's entry
   * points (as this did until 2026-09-10) funds nothing at all.
   */
  readonly proposalCodeDigest?: string
  /**
   * Fund plain transfers — transactions with no contract action at all. Default false.
   *
   * The reason it exists is the device: a phone cannot pay a Midnight fee without first syncing DUST,
   * and it does not have to, because the fee arrives in a separate balancing transaction. The reason it
   * defaults off is that it is the one clause not bounded by *our* contracts — see `SponsorshipPolicy`.
   */
  readonly fundTransfers?: boolean
  /**
   * Directory holding mirrored proving key material, which makes this client prove the fee balancing
   * in-process instead of calling {@link SponsorClientOptions.node}'s companion proof server.
   *
   * Required on a host that runs no proof server — which is the sponsor host by design
   * (docs/SPONSOR_HOST.md). Omitted → the SDK proves over HTTP at `proofServer`, which is what the
   * local standalone stack provides. See `prover-keys.ts` for the layout and how to populate it.
   */
  readonly proverKeysDir?: string
  /**
   * Called every ~5s while the sections catch up, before this constructor resolves.
   *
   * The cold sync is the longest thing this host ever does (34 minutes measured on preprod) and it
   * happens before there is a service to ask. Without this, a boot that is progressing normally and
   * one that has stalled look identical from outside.
   */
  readonly onSyncProgress?: (progress: {readonly unshielded: SectionSync; readonly dust: SectionSync}) => void
}

export type SponsorTx = {readonly txId: string; readonly blockHeight: string}

/**
 * How far a wallet section has caught up. Every count is a decimal string: these are `bigint`s and
 * this type is serialised to JSON.
 */
export type SectionSync = {
  /** The section's own verdict. Anything false means transactions built now may be built on stale state. */
  readonly complete: boolean
  /**
   * Decimal strings, or null before the section reports an index — which it does not do for the first
   * few ticks of a sync. Null is "not known yet", never zero: a fabricated 0 here would read as "no
   * progress" and, worse, as a lag equal to the whole chain.
   */
  readonly applied: string | null
  readonly highest: string | null
  /** `highest - applied`, or null when either side is unknown. */
  readonly lag: string | null
}

/**
 * A live read of the sponsor wallet — what a liveness probe cannot see.
 *
 * Every failure this reports is one the process survives: a stalled sync, an exhausted DUST balance
 * and an unobserved own-spend all leave the service answering requests and failing every one of them.
 */
export type SponsorStatus = {
  readonly network: string
  /**
   * The wallet this host actually loaded, so "which sponsor am I?" is answerable without the seed.
   * The question is not academic: the seed is one file, both of its formats are accepted, and a
   * rotation that quietly kept the old wallet looks identical to one that worked.
   */
  readonly address: string
  readonly sync: {readonly unshielded: SectionSync; readonly dust: SectionSync; readonly complete: boolean}
  /** Decimal strings — both are `bigint`. `dust` is what pays fees; at zero nothing can be sponsored. */
  readonly balances: {readonly night: string; readonly dust: string}
  /**
   * Own spends the indexer has not observed yet. Non-zero is normal mid-submission; persistently
   * non-zero means the sync is not seeing our own transactions, which is what
   * `walletCoinSync.waitForOwnSpends` blocks on before every build.
   */
  readonly pendingDust: number
}

export type SponsorClient = {
  /** Balance a device-proven transaction with the sponsor's DUST, submit it, and wait for it to land. */
  submitProven(txBytes: Uint8Array): Promise<SponsorTx>
  /**
   * A contract's current serialized ledger state, or `undefined` when nothing is deployed there.
   *
   * Exposed because the host acquired one job that needs to *read* the chain rather than only write to
   * it: minting an invite builds a transcript against the circle's live state. It reuses the wallet's
   * own indexer connection rather than configuring a second one — two endpoints for one host is how
   * they end up pointed at different networks.
   */
  contractState(address: string): Promise<Uint8Array | undefined>
  /** Snapshot the dust state, so the next boot skips the cold sync. */
  snapshot(): Promise<void>
  /** A live read of sync progress and balances. In-memory — the facade already holds this state. */
  status(): Promise<SponsorStatus>
}

/**
 * Exported for its own test: this is the function that took the sponsor's wallet boot down on
 * 2026-08-15 by trusting `appliedIndex` to be present on every tick.
 */
export const sectionSync = (progress: FacadeState['dust']['state']['progress'] | undefined): SectionSync => {
  const complete = progress?.isStrictlyComplete() ?? false
  const applied = progress?.appliedIndex
  const highest = progress?.highestRelevantWalletIndex
  if (applied === undefined || highest === undefined) {
    return {complete, applied: null, highest: null, lag: null}
  }
  return {
    complete,
    applied: applied.toString(),
    highest: highest.toString(),
    lag: (highest > applied ? highest - applied : 0n).toString(),
  }
}

/**
 * Placeholder for the provider factory's required `zkConfigPath`.
 *
 * Never read on this path: only the ZK config *provider* consumes it, and only when proving, which this
 * client cannot do. Pointing it at a real directory would reintroduce exactly the dependency this module
 * exists to remove.
 */
const UNUSED_ZK_CONFIG_PATH = '/nonexistent/sponsor-never-proves'

/** Deserialize proven-unbound bytes for inspection. Throws on anything that is not one. */
const deserializeProvenTx = (txBytes: Uint8Array): unknown => {
  const [markerS, markerP, markerB] = PROVEN_TX_MARKERS
  return Transaction.deserialize(markerS, markerP, markerB, txBytes)
}

/** Dedup key. The bytes are the whole identity of a submission, so hashing them is the right key. */
const txHash = (txBytes: Uint8Array): string => {
  let out = ''
  for (const b of sha256(txBytes)) out += b.toString(16).padStart(2, '0')
  return out
}

export const createSponsorClient = async (options: SponsorClientOptions): Promise<SponsorClient> => {
  const network = options.network ?? 'preprod'
  const defaults = networkDefaults(network)
  const log = options.log ?? (() => {})
  const env = {
    walletNetworkId: walletNetworkIdFor(network),
    networkId: network,
    indexer: options.indexer ?? defaults.indexer,
    indexerWS: options.indexerWS ?? defaults.indexerWS,
    node: options.node ?? defaults.node,
    nodeWS: options.nodeWS ?? defaults.nodeWS,
    // Contacted whenever `proverKeysDir` is unset: balancing proves, so the facade needs a prover.
    proofServer: options.proofServer ?? 'http://127.0.0.1:6300',
  }
  setNetworkId(network)

  const logger = createDefaultTestLogger()
  const wallet = await assembleWallet(logger, env, options.seed, {
    ...(options.dustStateFile === undefined ? {} : {dustStateFile: options.dustStateFile}),
    ...(options.proverKeysDir === undefined
      ? {}
      : {keyMaterialProvider: directoryKeyMaterialProvider(options.proverKeysDir)}),
  })
  // Logged before the sync, not after: which wallet this host became is knowable in milliseconds, and
  // the answer is 15 minutes away in `/status` once a cold sync is under way.
  log(`sponsor wallet ${wallet.unshieldedKeystore.getBech32Address().asString()} on ${network}`)
  await wallet.wallet.start(wallet.zswapSecretKeys, wallet.dustSecretKey)
  // The snapshot-less first boot is the long one, so the timeout has to cover it.
  await waitForSections(
    wallet,
    options.dustStateFile !== undefined ? 60 * 60_000 : 5 * 60_000,
    options.onSyncProgress === undefined
      ? undefined
      : (state) =>
          options.onSyncProgress?.({
            unshielded: sectionSync(state.unshielded.progress),
            dust: sectionSync(state.dust.state.progress),
          }),
  )
  await ensureDust(wallet as never, (message) => log(message))

  const snapshot = async (): Promise<void> => {
    if (options.dustStateFile === undefined) return
    try {
      await saveDustState(wallet as never, options.dustStateFile)
      log(`dust-state snapshot saved → ${options.dustStateFile}`)
    } catch (error) {
      // An optimisation for the NEXT boot; this process is already synced, so a failed save must not
      // take it down.
      log(`dust-state snapshot failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await snapshot()

  const providers = initializeMidnightProviders(wallet, env, {
    zkConfigPath: UNUSED_ZK_CONFIG_PATH,
    privateStateStoreName: 'pnyx-sponsor',
  })
  // Every submission balances through a wallet provider that does **not** sign the caller's
  // transaction. The SDK's own `balanceTx` does, which appends a second signature to an offer the
  // caller already signed — see `foreign-balancing.ts`. Substituted here rather than at the call site
  // so nothing on this host can balance a foreign transaction the signing way.
  const submitProviders = {...providers, walletProvider: foreignBalancingProvider(wallet as never)}

  // FIFO, so each submission observes the ledger only after the previous one's fee spend is visible.
  let queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const next = queue.then(op, op)
    // Keeps the tail from staying rejected; `next` carries the rejection to the caller.
    queue = next.catch((e) => {
      logger.info(`queued submission rejected: ${e instanceof Error ? e.message : String(e)}`)
      return undefined
    })
    return next
  }
  // Refused here rather than at the route, so no caller can bypass it: this is the object that spends.
  const policy = {
    identityCodeDigest: options.identityCodeDigest ?? '',
    identityEntryPoints: SPONSORED_IDENTITY_ENTRY_POINTS,
    circleCodeDigest: options.circleCodeDigest ?? '',
    fundTransfers: options.fundTransfers ?? false,
    circleEntryPoints: SPONSORED_CIRCLE_ENTRY_POINTS,
    proposalCodeDigest: options.proposalCodeDigest ?? '',
    proposalEntryPoints: SPONSORED_PROPOSAL_ENTRY_POINTS,
    paymentCodeDigest: options.paymentCodeDigest ?? '',
    paymentEntryPoints: SPONSORED_PAYMENT_ENTRY_POINTS,
    handleCodeDigest: options.handleCodeDigest ?? '',
    handleEntryPoints: SPONSORED_HANDLE_ENTRY_POINTS,
  }
  const dedup = createTxDeduplicator()

  /**
   * Addresses already recognised as one of ours.
   *
   * **Positive answers are cached forever, negative ones never.** That asymmetry is not a shortcut: a
   * circle's verifier keys can never change, because circles deploy with an unsatisfiable maintenance
   * authority (`docs/CONTRACT_MIGRATION.md`), so "this address is a circle of our template" is true for
   * the life of the chain. "It is not" is a claim about *right now* — most often it means the deploy
   * has not reached this indexer yet — and caching it would refuse every later call to a circle over
   * one moment's lag.
   */
  const recognised = new Map<string, ContractKind>()

  const recognise = async (address: string): Promise<ContractKind | undefined> => {
    const key = address.toLowerCase()
    const known = recognised.get(key)
    if (known !== undefined) return known
    // Both kinds are recognised by code now, identity included: it used to be matched against a
    // configured address, which cannot survive one contract per identity.
    const templates = [
      {kind: 'identity' as const, digest: policy.identityCodeDigest},
      {kind: 'circle' as const, digest: policy.circleCodeDigest},
      {kind: 'proposal' as const, digest: policy.proposalCodeDigest},
      {kind: 'payment' as const, digest: policy.paymentCodeDigest},
      {kind: 'handle' as const, digest: policy.handleCodeDigest},
    ].filter((template) => template.digest !== '')
    if (templates.length === 0) return undefined
    // One indexer read, once per contract this sponsor ever funds. The alternative — trusting the
    // caller's word for which contract it is talking to — is the hole this whole module exists to close.
    const state = await providers.publicDataProvider.queryContractState(address)
    if (!state) return undefined
    let digest: string
    try {
      digest = contractCodeDigest(state as never)
    } catch (error) {
      log(`could not read the code of contract ${address}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
    const matched = templates.find((template) => template.digest.toLowerCase() === digest.toLowerCase())
    if (matched === undefined) return undefined
    recognised.set(key, matched.kind)
    return matched.kind
  }

  const submit = createTxSubmitter(walletCoinSync(wallet), {
    ...options.retry,
    log: (message) => log(message),
  })

  return {
    submitProven: (txBytes) =>
      enqueue(async () => {
        if (
          policy.identityCodeDigest === '' &&
          policy.circleCodeDigest === '' &&
          policy.proposalCodeDigest === '' &&
          policy.paymentCodeDigest === '' &&
          policy.handleCodeDigest === ''
        ) {
          throw new Error('no code digest is configured for any contract; refusing to pay for an unchecked transaction')
        }
        let decoded: ReturnType<typeof decodeSponsoredTx>
        try {
          decoded = decodeSponsoredTx(txBytes, deserializeProvenTx)
        } catch (error) {
          throw new Error(
            `${SPONSORSHIP_REFUSAL_PREFIX}bytes are not a proven-unbound transaction (${
              error instanceof Error ? error.message : String(error)
            })`,
          )
        }
        // Resolved before the policy runs so the decision itself stays synchronous and total: the policy
        // is where the mistakes are, and one that could await mid-decision is one with an ordering to get
        // wrong. Only the single call a well-formed submission carries is ever looked up.
        const kinds = new Map<string, ContractKind>()
        for (const call of decoded.calls) {
          const kind = await recognise(call.address)
          if (kind !== undefined) kinds.set(call.address.toLowerCase(), kind)
        }
        const refusal = sponsorshipRefusal(decoded, policy, (address) => kinds.get(address.toLowerCase()))
        if (refusal !== undefined) {
          log(`refused: ${refusal}`)
          throw new Error(`${SPONSORSHIP_REFUSAL_PREFIX}${refusal}`)
        }
        // A proof that fails at the node still costs a balance and a submit, so one accepted proof
        // replayed is an unbounded drain the allowlist does nothing about.
        const hash = txHash(txBytes)
        if (!dedup.accept(hash)) {
          throw new Error(`${SPONSORSHIP_REFUSAL_PREFIX}this transaction has already been submitted`)
        }
        const result = await submit('submitProven', () =>
          balanceAndSubmitProven(submitProviders as never, txBytes, log),
        )
        return result as SponsorTx
      }),
    contractState: async (address) => {
      // Unqueued for the same reason `status` is: a read must answer while a submission is in flight.
      const state = await providers.publicDataProvider.queryContractState(address)
      return state ? (state as unknown as {serialize(): Uint8Array}).serialize() : undefined
    },
    snapshot,
    // Deliberately not queued: a status read must answer while a submission holds the queue, which is
    // exactly when something is stuck and someone is asking why.
    status: async () => {
      const state = await currentFacadeState(wallet)
      const unshielded = sectionSync(state.unshielded.progress)
      const dust = sectionSync(state.dust.state.progress)
      return {
        network,
        address: wallet.unshieldedKeystore.getBech32Address().asString(),
        sync: {unshielded, dust, complete: unshielded.complete && dust.complete},
        balances: {
          night: (state.unshielded.balances[nightRaw()] ?? 0n).toString(),
          dust: state.dust.balance(new Date()).toString(),
        },
        pendingDust: state.dust.state.pendingDust.length,
      }
    },
  }
}
