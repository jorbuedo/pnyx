/**
 * Cardano asset-data endpoints: token metadata, icons, and prices — all from
 * **SteelSwap** (`https://devapi.steelswap.io`, partner-keyed `/api/v2/*`;
 * keyless `/tokens/icon/{unit}/`). No Yoroi. Every URL lives here, never at a
 * call site (Third-Party RPC policy).
 *
 * The base resolves `EXPO_PUBLIC_CARDANO_STEELSWAP_URL` → control plane → the
 * constant below, which is what makes the proxy migration an operation rather
 * than a release: pointing the fleet at a host that injects the partner key
 * server-side retires the embedded key with no new build.
 *
 * @module
 */

import {
  cardanoMediaUrlOverride,
  cexplorerIconUrlOverride,
  steelswapPartnerKey,
  steelswapUrlOverride,
} from '../../config/env'
import type {FiatCurrency} from '../../providers/fiat-currencies'
import type {CardanoNetwork} from '../cardano/config'
import {mediaIconUrl} from './media-icon'

/** Which SteelSwap swap API to drive (token DATA always uses v2 — see below). */

export type CardanoAssetsConfig = {
  readonly network: CardanoNetwork
  /** SteelSwap base (POST `${base}/api/v2/…`, GET `${base}/tokens/icon/{unit}/`). */
  readonly steelswapUrl: string
  /**
   * The Pnyx partner key, when this build carries one.
   *
   * Absent is a real state, not a misconfiguration: the caller falls back to the per-install CIP-8
   * key, which still authenticates every route but attributes the swap fee to the user instead of
   * to Pnyx. Carried on the config rather than read from `env` at the call site so the auth module
   * stays injectable and its tests can state both worlds.
   */
  readonly steelswapPartnerKey?: string
  /**
   * `true` when {@link steelswapUrl} injects the credential server-side (our token proxy), so the
   * app sends no `authorization` and acquires no key of its own.
   *
   * ⚠️ Distinct from "there is no key": with no key AND no injection the caller mints a per-install
   * CIP-8 key, and on a testnet that mint cannot succeed — SteelSwap serves mainnet only and
   * rejects a testnet address, which takes token metadata and prices down with it.
   */
  readonly steelswapKeyInjectedByEndpoint: boolean
}

// SteelSwap serves mainnet Cardano DEX data only; one base for every network
// (token metadata/prices simply don't resolve on testnets → degrade to
// unknown/no-price, never a fabricated value).
//
// `devapi` and not `cicdapi`: both carry our live partner account, but they are separate
// deployments with separate fee ledgers, and the one named after CI is not the one to ship against.
const STEELSWAP_URL = 'https://devapi.steelswap.io'

// cexplorer image CDN — the token-icon fallback. Serves a small pre-sized WEBP
// for known assets and a generic placeholder for unknown ones (always 200).
// `unit` is the SteelSwap/cexplorer concatenated form (policyId+assetNameHex).
const CEXPLORER_ICON_URL = 'https://ix.cexplorer.io/asset'

// First-party asset media: NFT list icons, keyed by CIP-14 fingerprint. The only
// source that holds NFT artwork — SteelSwap and cexplorer both index *listed
// tokens*, so before this every NFT row rendered the same shipped placeholder.
// A miss is a 404 that falls through to that placeholder, so an asset the backfill
// has not reached yet behaves exactly as it did before.
const MEDIA_URL = 'https://media.pxkq.uk'

const overrideMedia = cardanoMediaUrlOverride()

// Expo inlines `process.env.EXPO_PUBLIC_*` only for literal member expressions.
const overrideSteelswap = steelswapUrlOverride()
const overrideCexplorer = cexplorerIconUrlOverride()
const partnerKey = steelswapPartnerKey()

/**
 * What the control plane last published as the SteelSwap base, in memory only.
 *
 * Mutable because the fleet has to be movable between a release's build and the next one — the
 * concrete case being the migration from an embedded partner key to a proxy that holds it
 * server-side. `undefined` is the resting state and means "use the build's own answer", so a remote
 * config that fails to load or arrives in a shape this build does not understand cannot take the
 * swap rail away.
 */
let remoteSteelswapUrl: string | undefined

/** Publish (or clear with `undefined`) the control plane's base. Called when remote config loads. */
export const setRemoteSteelswapUrl = (url: string | undefined): void => {
  const trimmed = url?.trim().replace(/\/+$/, '')
  remoteSteelswapUrl = trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * The partner key the control plane last published, in memory only.
 *
 * ⚠️ Published in a PUBLIC file (`config.pxkq.uk/<env>.json` is unauthenticated R2), by the
 * 2026-10-07 decision to stop carrying it as a build-time env var on `dev` and `preview`. The
 * exposure is accepted there and must not be extended to `prod.json`; `@pnyx/config`'s
 * `RemoteSwapConfig` carries the full reasoning and the two consequences.
 *
 * ⚠️ **It arrives late.** Remote config is fetched at boot, so for the first seconds of every launch
 * this is `undefined` and a swap quote in that window authenticates with the per-install CIP-8 key —
 * which succeeds and pays the fee to the user instead of to Pnyx. `steelswapCredentialState` reports
 * `partner` only once the key is in force, which is the signal a caller can wait on.
 */
let remotePartnerKey: string | undefined

/** Publish (or clear with `undefined`) the control plane's partner key. */
export const setRemoteSteelswapPartnerKey = (key: string | undefined): void => {
  const trimmed = key?.trim()
  remotePartnerKey = trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/**
 * Whether the published swap endpoint injects the credential itself.
 *
 * ⚠️ Arrives late, exactly like {@link remotePartnerKey}: until remote config lands this is
 * `false`, so a request in that window takes the key path. That is the safe direction — a
 * credential sent to an endpoint that also injects one is simply overwritten, whereas sending none
 * to an endpoint that does not inject is a 401.
 */
let remoteKeyInjectedByEndpoint = false

/** Publish the control plane's "the endpoint injects the credential" flag. */
export const setRemoteSteelswapKeyInjected = (injected: boolean): void => {
  remoteKeyInjectedByEndpoint = injected
}

/** Resolve the asset-data + swap endpoints for `network` (SteelSwap only). */
export const getCardanoAssetsConfig = (network: CardanoNetwork): CardanoAssetsConfig => ({
  network,
  // A build-time override outranks the control plane on purpose: it is how a developer points at
  // the dev proxy or a local mock, and a fleet-wide steer must not silently undo that.
  steelswapUrl: overrideSteelswap ?? remoteSteelswapUrl ?? STEELSWAP_URL,
  // Same precedence as the URL, and for the same reason: a value compiled into this build is a
  // deliberate local choice, and a fleet-wide push must not silently undo it. With the key now
  // coming from the control plane on dev and preview, the env var is the escape hatch rather than
  // the supply route.
  ...(() => {
    const key = partnerKey ?? remotePartnerKey
    return key === undefined ? {} : {steelswapPartnerKey: key}
  })(),
  // Only meaningful when the URL is the control plane's: a developer pointing `overrideSteelswap`
  // at a local mock or at SteelSwap directly must not inherit a fleet-wide "it injects for you".
  steelswapKeyInjectedByEndpoint: overrideSteelswap === undefined && remoteKeyInjectedByEndpoint,
})

/** First-party media icon URL for an app asset id; `null` for ADA/malformed ids — see `media-icon.ts`. */
export const assetMediaIconUrl = (assetId: string): string | null => mediaIconUrl(overrideMedia ?? MEDIA_URL, assetId)

/** cexplorer icon URL for a SteelSwap `unit` (policyId+assetNameHex); `null` for ADA. */
export const cexplorerIconUrl = (unit: string): string | null =>
  unit.length === 0 ? null : `${overrideCexplorer ?? CEXPLORER_ICON_URL}/${unit}`

/**
 * Map the app's fiat setting to a SteelSwap quote currency, or `null` when
 * SteelSwap can't quote it. SteelSwap quotes ADA/USD/EUR/BTC/ETH; only USD/EUR
 * are app fiats, so every other currency shows no fiat (never a wrong
 * conversion) until an FX layer or wider SteelSwap coverage lands.
 */
const STEELSWAP_QUOTE_CURRENCIES: Partial<Record<FiatCurrency, string>> = {
  USD: 'USD',
  EUR: 'EUR',
}
export const steelswapQuoteCurrency = (currency: FiatCurrency): string | null =>
  STEELSWAP_QUOTE_CURRENCIES[currency] ?? null

/** The fiat currencies the app can actually price today (Kraken's ADA pairs). */
export const SUPPORTED_FIAT_CURRENCIES: readonly FiatCurrency[] = ['USD', 'EUR', 'GBP', 'AUD']
