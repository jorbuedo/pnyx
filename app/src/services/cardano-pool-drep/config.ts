/**
 * Endpoints for stake-pool / DRep name + metadata resolution.
 *
 * The pool + DRep LISTS come exclusively from our R2-backed slow-data blobs
 * (`${dataUrl}/pools.json`, `/dreps.json` — served R2-direct, free; see
 * services/data-worker). Mainnet-only: on other networks `dataUrl` is undefined
 * and these features are not offered (no direct third-party fallback). Per-DRep
 * on-chain state still comes from Koios `drep_info` (rail-configured first-party
 * when available, else the public per-network default). Every base lives here,
 * never at a call site (Third-Party RPC policy).
 *
 * @module
 */

import {cardanoDataUrlOverride, cexplorerImgUrlOverride} from '../../config/env'
import type {CardanoNetwork} from '../cardano/config'
import {getCardanoRailConfig} from '../cardano/config'

export type PoolDRepConfig = {
  readonly network: CardanoNetwork
  /** Koios base (`POST ${koios}/drep_info`) — first-party when the rail is configured. */
  readonly koiosUrl: string
  /**
   * Our R2-backed slow-data base (`GET ${dataUrl}/pools.json`, `/dreps.json`) —
   * the first-party, free-egress source for the pool/DRep LISTS and, on mainnet,
   * the only source. `undefined` on testnets → the pool/DRep features are not
   * offered there. See services/data-worker.
   */
  readonly dataUrl?: string
}

// Public Koios per-network default — used only when no first-party rail endpoint
// is configured. Matches the rail's own default set.
const KOIOS_URL: Record<CardanoNetwork, string> = {
  mainnet: 'https://api.koios.rest/api/v1',
  preprod: 'https://preprod.koios.rest/api/v1',
  preview: 'https://preview.koios.rest/api/v1',
}

// Expo inlines `process.env.EXPO_PUBLIC_*` only for literal member expressions.
const overrideData = cardanoDataUrlOverride()

/** First-party R2 slow-data base (services/data-worker) — mainnet lists only. */
const DATA_URL = 'https://data.pxkq.uk'

// cexplorer image CDN — pool / DRep logos (`GET ${base}/{pool1…|drep1…}`). Serves
// a real logo for known ids and a generic placeholder otherwise (so the Image
// almost always renders; the avatar's initials disc is the last-resort fallback).
const CEXPLORER_IMG_URL = 'https://ix.cexplorer.io'
const overrideCexplorer = cexplorerImgUrlOverride()

/** cexplorer logo URL for a `pool1…` / `drep1…` bech32 id. */
export const cexplorerLogoUrl = (id: string): string => `${overrideCexplorer ?? CEXPLORER_IMG_URL}/${id}`

/**
 * The endpoints to resolve a single pool / DRep's **metadata** from.
 *
 * A pool or DRep id is a hash, so it means the same thing on every network — and
 * the R2 lists only exist for mainnet. Scoping a name lookup to the active
 * network therefore does not make it more correct, it just makes it fail: on a
 * testnet there is no list, so nothing ever resolved and every id rendered raw,
 * including a mainnet pool named in a link.
 *
 * So a lookup always consults the mainnet register. A testnet-only pool is simply
 * not found, which is exactly the answer it gave before. The cost is one cached
 * list fetch on a testnet that will usually miss — worth it so a link can say
 * whose pool it is.
 *
 * The *list* endpoints (the pickers) stay network-scoped: offering mainnet pools
 * to delegate to from preprod would be offering something that cannot happen.
 */
export const getPoolDRepRegisterConfig = (network: CardanoNetwork): PoolDRepConfig => ({
  ...getPoolDRepConfig(network),
  dataUrl: overrideData ?? DATA_URL,
})

/** Resolve the pool/DRep endpoints for `network` (Koios default + rail + env override). */
export const getPoolDRepConfig = (network: CardanoNetwork): PoolDRepConfig => {
  const rail = getCardanoRailConfig()
  // Prefer the first-party Koios only when it matches the requested network.
  const railKoios = rail !== null && rail.network === network ? rail.koiosUrl : undefined
  // The R2 slow-data blobs are mainnet-only; testnets have no list source. The
  // env override wins on any network.
  const dataUrl = overrideData ?? (network === 'mainnet' ? DATA_URL : undefined)
  return {
    network,
    koiosUrl: railKoios ?? KOIOS_URL[network],
    ...(dataUrl !== undefined ? {dataUrl} : {}),
  }
}
