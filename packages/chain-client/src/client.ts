// Chain client for the content service — reads on-chain state and submits transactions the CLIENT
// proved. It no longer proves anything itself.
//
// It used to mirror forum actions onto `pnyx.compact` by deriving each account's per-circle persona
// secret server-side (sha256 of a server secret + subject + circleId) and proving on the user's
// behalf — a documented dev-mode trust gap. That path is deleted: proving happens on the device
// (`docs/on-device-proving.md`), and after the contract split there is no shared forum contract for
// a server-side mirror to write to at all. What is left is the half that was always honest — read a
// contract's state, read an identity row, and balance + submit bytes somebody else proved.

import {setNetworkId} from '@midnight-ntwrk/midnight-js-network-id'
import {createDefaultTestLogger, initializeMidnightProviders} from '@midnight-ntwrk/testkit-js'
import {NetworkId} from '@midnight-ntwrk/wallet-sdk'
import {foreignBalancingProvider} from './foreign-balancing.js'
import {validateProvenTxBytes} from './proven.js'
import {createTxSubmitter, type SubmitRetryOptions} from './submission.js'
import {balanceAndSubmitProven} from './submit-proven.js'
import {assembleWallet, ensureDust, saveDustState, waitForSections, walletCoinSync} from './wallet.js'

export type ChainClientOptions = {
  /**
   * The deployed `identity.compact` — address **and** generated module, which are needed together.
   * The address alone would decode that contract's ledger through whichever module happened to be
   * loaded, and `identities` moved slot 12 → 0 at the split, so a mismatch does not fail loudly: it
   * returns a different field. Absent → `readIdentityRow` and `readContractState` refuse rather than
   * guessing which deployment to look at.
   *
   * There is no forum contract here any more. A circle is one contract per circle at an address
   * derived from its own arguments, and nothing server-side writes to one.
   */
  readonly identity?: {readonly contractAddress: string; readonly modulePath: string}
  readonly seed: string
  readonly network?: 'undeployed' | 'preprod' | (string & {})
  readonly indexer?: string
  readonly indexerWS?: string
  readonly node?: string
  readonly nodeWS?: string
  readonly proofServer?: string
  /** Coin-race hardening knobs (see submission.ts); defaults are production-sane. */
  readonly retry?: SubmitRetryOptions
  /**
   * Dust-state snapshot path (see wallet.ts). Set on networks with a deep dust history
   * (Preprod) so restarts resume the dust sync from the snapshot instead of cold-syncing;
   * saved after the initial sync and again on graceful stop(). Unset → no persistence.
   */
  readonly dustStateFile?: string
}

export type ChainTx = {txId: string; blockHeight: string}

/**
 * Placeholder for the provider factory's required `zkConfigPath`. Never read: only the ZK config
 * *provider* consumes it, and only when proving, which this client no longer does.
 */
const UNUSED_ZK_CONFIG_PATH = '/nonexistent/chain-client-never-proves'

export type ChainClient = {
  /**
   * Balance + submit a transaction the CLIENT already proved. The device ships a proven-but-unbound
   * tx (`Transaction<signature, proof, pre-binding>`); the service balances its DUST fee from the
   * sponsor wallet and submits it — no re-proving, and the user's witnesses never reach the service.
   * The FIFO queue and coin-race guard are what make concurrent submissions safe from one wallet.
   */
  submitProven(txBytes: Uint8Array): Promise<ChainTx>
  /**
   * The identity contract's current `ContractState`, serialized (tagged) — the public data a
   * device's native preimage builder executes `publishIdentityRow` against. Read-only (not queued):
   * the indexer serves it. A circle's state is read by its own address, which this client never
   * holds; the app reads that directly from an indexer.
   */
  readContractState(): Promise<Uint8Array>
  /**
   * One identity row by its commitment `C`, or `undefined` when nothing is published
   * (`docs/PNYX_IDENTITY_PLAN.md`). The result needs no filtering: the circuit authenticated the
   * write, so the row at `C` was written by whoever knows its preimage.
   */
  readIdentityRow(
    identity: Uint8Array,
  ): Promise<{anchor: Uint8Array; authPub: Uint8Array; name: Uint8Array} | undefined>
  stop(): Promise<void>
}

/**
 * Canonical endpoints per network. `undeployed` is the local standalone stack
 * (infra/standalone/compose.yml); `preprod` and `mainnet` are the official Midnight rails (preprod
 * matches harness/deploy-preprod.ts). The proof server is always local — proving never leaves the
 * machine regardless of target network.
 *
 * **Unknown networks throw** rather than falling back. This used to be `preprod ? … : localhost`,
 * which meant a `mainnet` client silently pointed every read and submit at 127.0.0.1 — an empty
 * chain, so the failure looked like "nothing is deployed" rather than "you are not talking to
 * mainnet". The endpoints are all verified to answer (`rpc.mainnet.midnight.network` reports
 * `"Midnight Mainnet"`).
 */
/**
 * A server-side environment override, blank treated as absent.
 *
 * ⚠️ This package runs on the sponsor host and in harnesses, never in the app bundle, so a value read
 * here stays on the machine. That is the whole reason a credential-bearing endpoint is expressed as
 * an env var rather than a constant: `packages/chain-client` is committed, the sponsor's environment
 * is not.
 */
const env = (name: string): string | undefined => {
  const value = process.env[name]
  return value === undefined || value.trim() === '' ? undefined : value
}

const NETWORK_ENDPOINTS: Readonly<Record<string, {indexer: string; indexerWS: string; node: string; nodeWS: string}>> =
  {
    mainnet: {
      // ⚠️⚠️ **Our own indexer, because Midnight's answers 410.** Measured 2026-10-13:
      // `indexer.mainnet.midnight.network` and `indexer.preprod.midnight.network` are both **410
      // Gone** — the second death `docs/CHAIN_ENDPOINTS.md` warned the 2026-10-06 revert could have.
      // Ours (`infra/midnight-public/`) reached the chain tip the same day and answers 200.
      //
      // ⚠️ A sponsor wallet that cannot reach an indexer does not degrade, it **never starts**:
      // `sponsor wallet failed to start: section sync timeout 3600000ms`, which is a 502 on every
      // sponsored write and reads nothing like an endpoint problem. See `docs/SPONSOR_HOST.md`.
      indexer: 'https://midnight-mainnet.pxkq.uk/api/v4/graphql',
      indexerWS: 'wss://midnight-mainnet.pxkq.uk/api/v4/graphql/ws',
      node: 'https://rpc.mainnet.midnight.network',
      nodeWS: 'wss://rpc.mainnet.midnight.network',
    },
    preprod: {
      // ⚠️ **410 as well, and the replacement needs a credential**, so the real URL arrives through
      // `MIDNIGHT_INDEXER_PREPROD` / `MIDNIGHT_INDEXER_WS_PREPROD` rather than living here: a key in
      // committed source is a leaked key. Blockfrost answers preprod with `?project_id=` in the
      // query string. The dead host stays as the fallback so an unset env fails loudly against a
      // name that is visibly gone, rather than silently against a key-less 403.
      indexer: env('MIDNIGHT_INDEXER_PREPROD') ?? 'https://indexer.preprod.midnight.network/api/v4/graphql',
      indexerWS: env('MIDNIGHT_INDEXER_WS_PREPROD') ?? 'wss://indexer.preprod.midnight.network/api/v4/graphql/ws',
      node: 'https://rpc.preprod.midnight.network',
      nodeWS: 'wss://rpc.preprod.midnight.network',
    },
    preview: {
      indexer: 'https://indexer.preview.midnight.network/api/v4/graphql',
      indexerWS: 'wss://indexer.preview.midnight.network/api/v4/graphql/ws',
      node: 'https://rpc.preview.midnight.network',
      nodeWS: 'wss://rpc.preview.midnight.network',
    },
    undeployed: {
      indexer: 'http://127.0.0.1:8088/api/v4/graphql',
      indexerWS: 'ws://127.0.0.1:8088/api/v4/graphql/ws',
      node: 'http://127.0.0.1:9944',
      nodeWS: 'ws://127.0.0.1:9944',
    },
  }

export const networkDefaults = (network: string) => {
  const endpoints = NETWORK_ENDPOINTS[network]
  if (endpoints === undefined) {
    throw new Error(
      `no Midnight endpoints for network '${network}' (known: ${Object.keys(NETWORK_ENDPOINTS).join(', ')})`,
    )
  }
  return endpoints
}

/**
 * The wallet SDK's network id for `network`.
 *
 * The SDK's enum values *are* these strings, so this validates rather than translates. It used to be
 * `undeployed ? Undeployed : PreProd`, which signed a mainnet transaction with the preprod id — the
 * kind of mismatch that surfaces as an opaque rejection at the node.
 */
export const walletNetworkIdFor = (network: string): string => {
  const known = Object.values(NetworkId.NetworkId) as string[]
  if (!known.includes(network)) {
    throw new Error(`'${network}' is not a Midnight network id (known: ${known.join(', ')})`)
  }
  return network
}

export const createChainClient = async (options: ChainClientOptions): Promise<ChainClient> => {
  const network = options.network ?? 'undeployed'
  const defaults = networkDefaults(network)
  const env = {
    walletNetworkId: walletNetworkIdFor(network),
    networkId: network,
    indexer: options.indexer ?? defaults.indexer,
    indexerWS: options.indexerWS ?? defaults.indexerWS,
    node: options.node ?? defaults.node,
    nodeWS: options.nodeWS ?? defaults.nodeWS,
    proofServer: options.proofServer ?? 'http://127.0.0.1:6300',
  }
  setNetworkId(network)

  const logger = createDefaultTestLogger()
  const wallet = await assembleWallet(logger, env, options.seed, {
    ...(options.dustStateFile === undefined ? {} : {dustStateFile: options.dustStateFile}),
  })
  await wallet.wallet.start(wallet.zswapSecretKeys, wallet.dustSecretKey)
  // Preprod's dust history takes ~15 min to cold-sync; a snapshot boot only replays the
  // catch-up, but the timeout must still cover the snapshot-less first boot.
  await waitForSections(wallet, options.dustStateFile !== undefined ? 60 * 60_000 : 5 * 60_000)
  await ensureDust(wallet as never, (message) => logger.info(message))
  const snapshotDustState = async (context: string) => {
    if (options.dustStateFile === undefined) {
      return
    }
    try {
      await saveDustState(wallet as never, options.dustStateFile)
      logger.info(`dust-state snapshot saved (${context}) → ${options.dustStateFile}`)
    } catch (error) {
      // Snapshotting is an optimization for the NEXT boot — this process is already
      // synced, so a failed save must not take it down.
      logger.warn(`dust-state snapshot failed (${context}): ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  await snapshotDustState('post-sync')

  // No `zkConfigPath` that matters and no contract binding: this client never proves and never calls
  // a circuit, so there is nothing to compile against. `findDeployedContract` used to run here for
  // the server-proving rail; deleting it also removed the only reason this package needed the
  // compactc output on disk.
  const providers = initializeMidnightProviders(wallet, env, {
    zkConfigPath: UNUSED_ZK_CONFIG_PATH,
    privateStateStoreName: 'pnyx-chain-client',
  })
  // Device-proven bytes are somebody else's transaction, so they balance through the provider that
  // leaves their signatures alone (`foreign-balancing.ts`).
  const submitProviders = {...providers, walletProvider: foreignBalancingProvider(wallet as never)}

  // FIFO queue — every op observes the ledger only after its own confirmed transaction.
  let queue: Promise<unknown> = Promise.resolve()
  const enqueue = <T>(op: () => Promise<T>): Promise<T> => {
    const next = queue.then(op, op)
    // Keeps the tail from staying rejected; `next` carries the rejection to the caller.
    queue = next.catch((e) => {
      logger.info(`queued op rejected: ${e instanceof Error ? e.message : String(e)}`)
      return undefined
    })
    return next
  }
  // Every individual transaction goes through the guarded submitter: it blocks the queue
  // until the wallet observed its own fee spend and retries 1010-class rejections after a
  // wallet resync (rebuild happens by re-invoking callTx against the synced coin set).
  const submit = createTxSubmitter(walletCoinSync(wallet), {
    ...options.retry,
    log: (message) => logger.info(message),
  })

  return {
    submitProven: (txBytes) => {
      const bytes = validateProvenTxBytes(txBytes)
      // Balance + submit through the same coin-race guard as callTx: on a 1010/panic retry the
      // closure re-deserializes and re-balances the unbound tx against the freshly synced coins,
      // so the sponsor's DUST fee is re-selected — the proof itself is untouched.
      return enqueue(() =>
        submit('submitProven', () =>
          balanceAndSubmitProven(submitProviders as never, bytes, (message) => logger.info(message)),
        ),
      )
    },
    /**
     * One identity row, or `undefined` when nothing has been published for `C`.
     *
     * No verification here and none needed: the circuit authenticated the write, so whatever is at
     * row `C` was put there by whoever knows its preimage. That is the whole point of the design:
     * the old keybook returned unvalidated claims every reader had to filter.
     */
    readIdentityRow: async () => {
      // ⚠️ **Retired, deliberately, rather than left to fail deeper.** This read looked a row up in the
      // `identities` map of one global contract, and that map is gone: identity is one contract per
      // identity at an address derived from `C` (`docs/BOUNDED_STATE_ARCHITECTURE.md` §1). The reader
      // that replaced it is the Worker's wasm decoder, which is handed the address and checks the
      // contract's code digest — see `services/content/src/worker.ts`.
      //
      // Kept as an explicit refusal so a local Node deployment says what is wrong instead of throwing
      // `cannot read properties of undefined (reading 'member')` from inside a generated module.
      throw new Error(
        'readIdentityRow is retired: identity is one contract per identity, so a row is read at the address derived from C',
      )
    },
    readContractState: async () => {
      if (options.identity === undefined) {
        throw new Error('no identity contract configured; this client has no contract state to read')
      }
      const state = await providers.publicDataProvider.queryContractState(options.identity.contractAddress)
      if (!state) {
        throw new Error('contract state unavailable from the indexer')
      }
      return (state as {serialize(): Uint8Array}).serialize()
    },
    stop: async () => {
      await snapshotDustState('pre-stop')
      await wallet.stop()
    },
  }
}
