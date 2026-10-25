/**
 * **The only place that answers "which Midnight endpoint?".** Every indexer and node URL in the app
 * comes from here; nothing else may resolve one, and no endpoint is ever read from an environment
 * variable except the one documented override below.
 *
 * There are **two independent network axes**, and conflating them is the whole reason this module is
 * the single source:
 *
 * | axis | what lives there | chosen by | changes |
 * |---|---|---|---|
 * | **identity** | the ID and Community contracts we deploy | `EXPO_PUBLIC_PNYX_NETWORK` | at build time |
 * | **funds** | the wallet's own NIGHT and DUST | the in-app network selector | at runtime, per tap |
 *
 * ⚠️ **A build-time constant can never answer the funds question.** It is right for whichever selector
 * position the build was made under and wrong for the other. That is not hypothetical: two variables,
 * `EXPO_PUBLIC_MIDNIGHT_INDEXER_URL` and `EXPO_PUBLIC_MIDNIGHT_NODE_URL`, used to supply funds
 * endpoints, and `.env.preview` set the indexer to **mainnet**. A preview build with the selector on
 * preprod therefore derived a correct `mn_dust_preprod` address and handed it to a mainnet indexer,
 * which refused it — `invalid bech32m dust address: expected HRP mn_dust, but was mn_dust_preprod`.
 * Both variables are gone; a funds endpoint is derived from the selected network, always.
 *
 * The identity axis keeps exactly one override, {@link identityIndexerUrlFor}'s, because a **device**
 * talking to a local standalone chain cannot reach `undeployed`'s loopback address. It is scoped to the
 * declared identity network so it can never answer for a network it was not meant for.
 *
 * Mirrors `packages/chain-client/src/client.ts`'s `networkDefaults`, which is the same table for the
 * service side. Both are the **official Midnight rails**, not third-party endpoints: they are the
 * chain's own infrastructure, which is what the Third-Party RPC policy points at.
 *
 * Every URL here has been verified to answer (preprod + mainnet indexers queried for a real contract;
 * mainnet RPC returns `"Midnight Mainnet"`; preview RPC returns `"Midnight Preview"` and its indexer
 * answered `{ block { height } }` with 603,364 on 2026-08-27).
 *
 * @module
 */

import type {Network} from '@pnyx/wallet'

import {chainAvailability, remoteMidnightEndpoints} from '../../config/chain-availability'
import {
  type EndpointKind,
  type EndpointSource,
  indexerWebsocketUrl,
  resolveEndpoint,
} from '../../config/chain-endpoints'
import {pnyxIndexerUrlOverride, preprodIndexerOverride} from '../../config/env'
import {logger} from '../../logger'
import {declaredIdentityNetwork} from '../identity-network'
import {
  currentRemoteRules,
  type EndpointRegistrySnapshot,
  getEndpointRegistrySnapshot,
  remoteEndpointDefault,
  userEndpointOverride,
} from './endpoint-overrides'
import {splitIndexerCredential} from './indexer-auth'

/**
 * The indexer GraphQL endpoint per network.
 *
 * `undeployed` is the local standalone stack (`infra/standalone/compose.yml`), which is reachable at
 * a loopback address — correct for a simulator or the host, and unreachable from a physical device.
 * A LAN build against a local chain therefore needs the override; see {@link module:./contract-state}.
 */
const INDEXER: Readonly<Record<string, string>> = {
  // ⚠️⚠️ **Midnight's public indexers are gone, and this is the second time.** `docs/CHAIN_ENDPOINTS.md`
  // warned the 2026-10-06 revert could die again; measured 2026-10-13, it has:
  //
  // | host | answer |
  // |---|---|
  // | `indexer.mainnet.midnight.network` | **410 Gone** |
  // | `indexer.preprod.midnight.network` | **410 Gone** |
  // | `midnight-mainnet.pxkq.uk` (ours) | **200**, height 2,997,568 |
  //
  // So mainnet is our own indexer (`infra/midnight-public/`) behind its Cloudflare Tunnel — the
  // walk reached the chain tip on 2026-10-13 and it now serves the live head. The 1033 that sent
  // this back to Midnight's host in October is gone with it.
  mainnet: 'https://midnight-mainnet.pxkq.uk/api/v4/graphql',
  // ⚠️ **Preprod needs a key, so its URL is not here.** Blockfrost answers preprod
  // (`midnight-preprod.blockfrost.io/api/v4/graphql`) but 403s without a `project_id`, and a
  // credential does not belong in committed source. The URL comes from
  // `EXPO_PUBLIC_MIDNIGHT_INDEXER_PREPROD` (gitignored local env) or the control plane; the key
  // travels as a header (`./indexer-auth.ts`), and is **split off here** if it was configured
  // inside the URL — what this table hands out is read by logs, the probe and connected dApps.
  // ⚠️ Left pointing at the dead host rather than removed: a *missing* entry reads as "we know no
  // indexer for preprod" and takes the network away, where a dead one still falls through to the
  // remote and user overrides that `docs/CHAIN_ENDPOINTS.md` exists to provide.
  preprod: splitIndexerCredential(preprodIndexerOverride() ?? 'https://indexer.preprod.midnight.network/api/v4/graphql')
    .url,
  preview: 'https://indexer.preview.midnight.network/api/v4/graphql',
  undeployed: 'http://127.0.0.1:8088/api/v4/graphql',
}

/**
 * The chain's own substrate RPC per network — where a **sealed** transaction is submitted.
 *
 * Separate from {@link INDEXER} because the two answer different questions: the indexer is read-only
 * (its GraphQL schema offers `connect` and `disconnect` and nothing else), so `author_submitExtrinsic`
 * on the node is the only route a transaction that pays its own fee can take.
 */
const NODE: Readonly<Record<string, string>> = {
  mainnet: 'https://rpc.mainnet.midnight.network',
  preprod: 'https://rpc.preprod.midnight.network',
  preview: 'https://rpc.preview.midnight.network',
  undeployed: 'http://127.0.0.1:9944',
}

/**
 * The same node over WebSocket — the only transport that can carry a transaction worth submitting.
 *
 * ⚠️ **The public RPC's HTTP front end refuses a request body over 8 KiB.** Measured against preprod by
 * bisection on 2026-09-05: an 8,189-byte body answers 200 and an 8,205-byte one answers a bare nginx
 * `403 Forbidden`. `author_submitExtrinsic` itself is not blocked — a small one gets a normal JSON-RPC
 * error back — so the refusal names nothing about the transaction and reads like a permissions problem.
 *
 * A transaction is hex inside JSON, so that cap lands at roughly **4 KB of transaction**: enough for a
 * plain transfer, and not enough for any contract call. A `setPrice` call is 5,041 bytes before a fee
 * and 8,298 after paying its own DUST (the dust spend's proof alone is `DUST_SPEND_PROOF_SIZE` = 2,912
 * bytes), so both sides of that were over.
 *
 * WebSocket frames are not subject to it, and substrate serves the same JSON-RPC methods there. There
 * is deliberately **no HTTP fallback** for submission: falling back would restore a 4 KB cliff that
 * fails as a 403 naming nothing.
 */
const NODE_WS: Readonly<Record<string, string>> = {
  mainnet: 'wss://rpc.mainnet.midnight.network',
  preprod: 'wss://rpc.preprod.midnight.network',
  preview: 'wss://rpc.preview.midnight.network',
  undeployed: 'ws://127.0.0.1:9944',
}

/**
 * The human-facing faucet page per network, or absent where there is none.
 *
 * Both are Midnight's own, on the same host shape. Preprod previously pointed at a Nethermind-hosted
 * faucet (`midnight-tmnight-preprod.nethermind.dev`) because the official one was broken when a
 * preprod address last needed funding; that stand-in is now closed and `faucet.preprod.midnight.network`
 * is the official replacement.
 *
 * Mainnet has no entry and must not gain one: tNIGHT does not exist there, and a button leading
 * nowhere is worse than no button. `undeployed`'s genesis wallet is pre-funded, so it needs none.
 */
const FAUCET: Readonly<Record<string, string>> = {
  preprod: 'https://faucet.preprod.midnight.network/',
  preview: 'https://faucet.preview.midnight.network/',
}

/**
 * The indexer for `network`, or `null` when we have no entry for it.
 *
 * `null` rather than a guess: an unknown network name is a configuration fault, and substituting a
 * neighbour's endpoint would read another chain's state as though it were this one's.
 */
/**
 * Resolve one endpoint through the three sources, after the kill switch.
 *
 * ⚠️ **A network the control plane has switched off resolves to `null`, not to its built-in URL.**
 * `null` is the answer every consumer here already handles — it is what an unknown network has
 * always returned — so one rule at this choke point takes a dead chain away from every screen,
 * sync and submit path at once, instead of each of them learning about availability separately.
 * That is the whole point of the mechanism: on 2026-09-30 a decommissioned host kept being called
 * by every install that had it compiled in.
 */
const resolveMidnight = (kind: 'indexer' | 'node' | 'nodeWs', network: string | null, builtin: string | null) => {
  if (network === null) return null
  const availability = chainAvailability(currentRemoteRules(), 'midnight', network as Network)
  if (!availability.usable) {
    logger.debug('midnight endpoint withheld: network switched off by remote config', {
      network,
      kind,
      reason: availability.reasonCode ?? 'unspecified',
    })
    return null
  }
  return resolveEndpoint({
    user: userEndpointOverride(network as Network, kind),
    remote: remoteEndpointDefault(network as Network, kind),
    builtin,
  }).value
}

/**
 * The indexer for `network`, or `null` when we have no entry for it, the device has not overridden
 * one, and the control plane has not published one — or when that pair is switched off.
 *
 * `null` rather than a guess: an unknown network name is a configuration fault, and substituting a
 * neighbour's endpoint would read another chain's state as though it were this one's.
 */
export const midnightIndexerFor = (network: string | null): string | null =>
  resolveMidnight('indexer', network, network === null ? null : (INDEXER[network] ?? null))

/** The node RPC for `network`, or `null` when we have no entry for it. Same reasoning as the indexer. */
export const midnightNodeFor = (network: string | null): string | null =>
  resolveMidnight('node', network, network === null ? null : (NODE[network] ?? null))

/**
 * The node's WebSocket RPC for `network`, or `null` when we have no entry. See {@link NODE_WS}.
 *
 * A device that overrode only the HTTP node URL gets a websocket derived from it rather than the
 * built-in one, which would otherwise point at a different host than every other call.
 */
export const midnightNodeWsFor = (network: string | null): string | null => {
  const explicit = resolveMidnight('nodeWs', network, null)
  if (explicit !== null) return explicit
  const node = midnightNodeFor(network)
  if (node !== null && userEndpointOverride(network as Network, 'node') !== undefined) {
    return node.replace(/^http/, 'ws')
  }
  return resolveMidnight('nodeWs', network, network === null ? null : (NODE_WS[network] ?? null))
}

/**
 * The indexer's websocket, derived from whichever indexer URL won.
 *
 * Exported so subscription call sites stop deriving it themselves from a URL they resolved
 * separately — a custom indexer must get a custom socket.
 */
export const midnightIndexerWsFor = (network: string | null): string | null => {
  const indexer = midnightIndexerFor(network)
  return indexer === null ? null : indexerWebsocketUrl(indexer)
}

/**
 * The faucet page for `network`, or `null` where that network has none.
 *
 * `null` is a real answer here, not a missing entry: it is what makes the button absent on mainnet
 * and on the local chain rather than pointing somewhere that cannot fund the address it was given.
 */
export const midnightFaucetFor = (network: string | null): string | null =>
  network === null ? null : (FAUCET[network] ?? null)

/** The networks this build knows endpoints for — for diagnostics and error messages. */
export const knownMidnightNetworks = (): readonly string[] => Object.keys(INDEXER)

/**
 * Which Midnight network a funds wallet reads, given the app's (Cardano-named) network.
 *
 * The app names its networks after Cardano's because Cardano is the funds chain, and the names happen to
 * line up one-to-one: Midnight has a mainnet, a preprod and a preview of its own. `null` means "no
 * endpoint we know" and is still the honest answer for anything else.
 *
 * ⚠️ This is deliberately **not** the bridge's pairing, and the two now disagree visibly. The USDM
 * bridge pairs Cardano *preprod* with Midnight *preview* (`docs/BOUNDED_STATE_ARCHITECTURE.md` §3.3.1),
 * so bridged tUSDM leaves a preprod Cardano wallet and arrives on the Midnight chain this function
 * reaches from the *preview* selector position. That asymmetry is the bridge's own; a bridged-asset
 * flow has to resolve it rather than reuse this. Making them agree instead would point the preprod
 * position at a chain none of our deployed identity, handle or DUST state exists on.
 */
/**
 * Explicit endpoint override for the identity chain — the one case the table cannot cover: a **device**
 * talking to a local standalone chain, where `undeployed`'s loopback address is the dev machine's, not
 * the phone's.
 *
 * Read once at module scope because Expo inlines only literal member expressions on `process.env`.
 */
const rawIdentityOverride = pnyxIndexerUrlOverride()

/**
 * The **identity** chain's indexer for a specific network, or `null` when we know none for it.
 *
 * A contract address is only meaningful on the chain it was deployed to, so anything reading a
 * network-pinned contract has to pair it with that network's indexer. Mismatching them fails quietly:
 * the wrong chain's indexer answers `contractAction: null`, which is indistinguishable from "nothing is
 * deployed there".
 *
 * The override applies **only** to the declared identity network — a loopback address is not a valid
 * answer for "where is mainnet's indexer".
 */
export const identityIndexerUrlFor = (network: string | null): string | null => {
  const override = rawIdentityOverride?.trim()
  if (override !== undefined && override !== '' && network === declaredIdentityNetwork()) return override
  return midnightIndexerFor(network)
}

/** The identity chain's indexer for the network this build declares. */
export const identityIndexerUrl = (): string | null => identityIndexerUrlFor(declaredIdentityNetwork())

export const midnightFundsNetwork = (appNetwork: string | null): string | null => {
  switch (appNetwork) {
    case 'mainnet':
      return 'mainnet'
    case 'preprod':
      return 'preprod'
    case 'preview':
      return 'preview'
    default:
      return null
  }
}

/**
 * Everything the settings screen needs to show about one endpoint: what is in force, where it came
 * from, and what it would fall back to.
 *
 * Exported from here rather than assembled in the screen because the built-in table is this
 * module's and must stay that way — a screen that reached for its own copy of a URL would be a
 * second source of the answer, which is the thing this module exists to prevent.
 */
export const describeMidnightEndpoint = (
  network: Network,
  kind: EndpointKind,
  /**
   * The registry snapshot to read. Passed explicitly by React callers so the data flow is visible
   * to React Compiler, which ignores dependency arrays and would otherwise never recompute this.
   */
  registry: EndpointRegistrySnapshot = getEndpointRegistrySnapshot(),
): {
  readonly effective: string | null
  readonly source: EndpointSource
  readonly user: string | undefined
  readonly remote: string | undefined
  readonly builtin: string | null
  /** What would be used if the device override were cleared — what the field shows as placeholder. */
  readonly fallback: string | null
} => {
  const builtin = builtinMidnightEndpoint(network, kind)
  const user = registry.user[network]?.[kind]
  const remote = remoteMidnightEndpoints(registry.remote, network)?.[kind]
  const resolved = resolveEndpoint({user, remote, builtin})
  return {
    effective: resolved.value,
    source: resolved.source,
    user,
    remote,
    builtin,
    fallback: resolveEndpoint({remote, builtin}).value,
  }
}

/** The URL compiled into this build for a network and kind. */
export const builtinMidnightEndpoint = (network: Network, kind: EndpointKind): string | null => {
  const table = kind === 'indexer' ? INDEXER : kind === 'node' ? NODE : NODE_WS
  return table[network] ?? null
}
