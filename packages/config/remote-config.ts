/**
 * Remote configuration fetching.
 *
 * Fetches runtime configuration from a remote URL. The remote config provides
 * values that can change without an app update: the dApp discovery list,
 * feature-flag overrides, maintenance flags, banners, and the push-notification
 * link allowlist.
 *
 * @module
 */

import {Data, Effect} from 'effect'
import type {FeatureFlagsConfig} from './feature-flags.js'

/**
 * Remote fetch failure.
 */
export class ConfigLoadError extends Data.TaggedError('ConfigLoadError')<{
  readonly message: string
  readonly cause?: unknown
}> {}

/**
 * DApp configuration for discovery/browser.
 */
export type RemoteDappConfig = {
  readonly banned?: ReadonlyArray<string>
  readonly recommended?: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly description: string
    readonly category: string
    readonly logo: string
    readonly uri: string
    readonly origins: ReadonlyArray<string>
    readonly isSingleAddress?: boolean
  }>
  readonly filters?: Record<string, ReadonlyArray<string>>
}

/**
 * Maintenance flags for features and chains.
 *
 * Keys are feature names (e.g. 'send', 'app') or chain IDs (e.g. 'cardano', 'midnight').
 * `true` means the feature/chain is in maintenance mode (visible but disabled).
 * Absence or `false` means working normally.
 */
export type RemoteMaintenanceConfig = Partial<Record<string, boolean>>

/**
 * Allowlist for **push-notification deep links** only.
 *
 * Keys are link identifiers, values are allowed URL prefixes. The wire
 * field is still called `allowedLinks` (the remote-config JSON contract
 * lives in the remote-config repo and we don't want to break it), but
 * the type name reflects its sole consumer: the push-notification
 * handler in the app, where the allowlist is a real trust boundary
 * (push payloads come from outside the remote-config control plane).
 *
 * **Not for banner CTAs.** Banners and this allowlist are siblings in
 * the same remote-config JSON, so an allowlist check inside the app
 * provides no defense against a malicious banner — same writer
 * controls both. See `app/src/services/allowed-links.ts` for
 * the full rationale.
 */
export type RemoteAllowedNotificationLinks = Partial<Record<string, string>>

export type RemoteBannerPlatform = 'ios' | 'android' | 'web' | 'extension'

/**
 * Surface identifier for where a banner should render. The app maintains a
 * single global banner list; each consuming surface mounts `<RemoteBanners
 * slot="…" />` with its own identifier and filters the list to banners
 * tagged for that slot.
 *
 * `'home'` is the only slot today. New slots are added by mounting a
 * `<RemoteBanners>` with the new identifier in the target surface and
 * documenting it here — not by sprinkling mounts and hoping banners route
 * correctly.
 */
export type RemoteBannerSlot = 'home'

/**
 * Banner configuration for in-app announcements.
 */
export type RemoteBanner = {
  readonly id: string
  readonly contentId: string
  readonly type: 'info' | 'warning' | 'error' | 'success'
  readonly imageUrl?: string
  readonly ctaLink?: string
  readonly startDate?: string
  readonly endDate?: string
  readonly isDismissible: boolean
  readonly priorityWeight: number
  /**
   * Where this banner should render. Missing → defaults to `'home'` to
   * keep pre-slot remote configs working. Set explicitly when targeting
   * a non-home surface, or when adding a new slot you want the banner
   * scoped to.
   */
  readonly slot?: RemoteBannerSlot
  readonly platformOverrides?: Partial<Record<RemoteBannerPlatform, RemoteBannerOverride>>
}

export type RemoteBannerOverride = Partial<
  Pick<
    RemoteBanner,
    | 'contentId'
    | 'type'
    | 'imageUrl'
    | 'ctaLink'
    | 'startDate'
    | 'endDate'
    | 'isDismissible'
    | 'priorityWeight'
    | 'slot'
  >
>

/**
 * Remote configuration shape.
 *
 * This is intentionally loose — the remote JSON may contain fields
 * we don't use yet, and we only extract what we need.
 */
/**
 * Chains whose endpoints and availability the control plane can steer.
 *
 * `midnight` and `cardano` are the two the wallet reads from directly. The derive-only chains
 * (BTC/EVM/SOL) have no endpoint of their own to shut off, so they are deliberately absent rather
 * than present-and-ignored.
 */
export type RemoteChain = 'midnight' | 'cardano'

/** The three networks the app selector offers. Named after Cardano's, as everywhere in the app. */
export type RemoteNetworkName = 'mainnet' | 'preprod' | 'preview'

/**
 * Endpoint defaults pushed from the control plane, replacing the ones built into the app.
 *
 * Every field is optional and every one is independent: pushing an `indexer` does not disturb a
 * `node` the build already knows. Only Midnight reads `indexer`/`node`/`nodeWs`, and only Cardano
 * reads `swapApi`; the rest of Cardano's rail is configured through its own env-driven config, so a
 * Cardano entry here carries availability plus that one host.
 */
export type RemoteEndpoints = {
  readonly indexer?: string
  readonly node?: string
  readonly nodeWs?: string
  /**
   * Cardano only: the SteelSwap API base the fleet should use.
   *
   * Exists so the partner key can stop being embedded without an app release — pointing this at a
   * host that injects the key server-side moves every installed build at once. ⚠️ Not a place for
   * the key itself: this JSON is served publicly, so a credential written here is published rather
   * than hidden.
   */
  readonly swapApi?: string
}

/**
 * What the control plane says about one (chain, network) pair.
 *
 * `enabled: false` means the app must not talk to that chain on that network at all — the case this
 * exists for is an endpoint being decommissioned under us, where continuing to call it produces
 * errors that look like user faults. `reasonCode` names an i18n key under
 * `settings.endpoints.reason.*` so the app can say *why* a network is unavailable instead of
 * failing silently; an unrecognised code falls back to the generic sentence.
 */
export type RemoteNetworkRule = {
  readonly enabled?: boolean
  readonly reasonCode?: string
  readonly endpoints?: RemoteEndpoints
}

/**
 * The per-chain, per-network rule matrix.
 *
 * Absent means "no opinion", which the app reads as available with built-in endpoints. That
 * direction is deliberate: a remote config that fails to load, or that a future version writes in a
 * shape this build does not understand, must not be able to brick a working wallet. Only an explicit
 * `enabled: false` takes a network away.
 */
export type RemoteNetworksConfig = Partial<Record<RemoteChain, Partial<Record<RemoteNetworkName, RemoteNetworkRule>>>>

/**
 * Swap-rail configuration pushed from the control plane.
 *
 * ⚠️⚠️ **`partnerApiKey` is a CREDENTIAL IN A PUBLIC FILE.** The remote config is served R2-direct
 * from an unauthenticated custom domain, so anything written here is readable by anyone who requests
 * the URL — no reverse engineering, one `curl`. It is here by an explicit 2026-10-07 decision to get
 * the key out of build-time env vars for the `dev` and `preview` variants, accepting that exposure;
 * it must NOT be published in `prod.json`.
 *
 * Two consequences a future reader needs:
 *
 * - **SteelSwap issues us one key at a time** (`POST /auth/keys` is `409` while an active key
 *   exists), so this is the same credential every variant uses. Publishing it for dev publishes it
 *   for production.
 * - **We cannot rotate it ourselves.** Our partner account carries no `maintenance_address`, so the
 *   CIP-8 login that mints and revokes cannot resolve to it; a leak is a support request to
 *   SteelSwap.
 *
 * The durable fix is `endpoints.swapApi` pointing at a host that holds the key server-side, which
 * makes this field unnecessary rather than merely risky.
 */
export type RemoteSwapConfig = {
  readonly partnerApiKey?: string
  /**
   * `true` when {@link RemoteEndpoints.swapApi} injects the partner credential server-side, so the
   * app must acquire none and send no `authorization` at all.
   *
   * ⚠️ **This is what makes {@link partnerApiKey} removable, and it is not optional detail.**
   * Without it a build that finds no partner key falls through to minting a per-install CIP-8 key,
   * and that handshake posts the wallet's address to SteelSwap — which serves **mainnet only** and
   * answers `400 Invalid address` for a testnet one. The gate then fails before any request is
   * made, so token metadata and prices go dark on preprod, not just swaps. Measured on device
   * 2026-10-18, which is why the key went back into `dev`/`preview` until this flag shipped.
   *
   * ⚠️ Only set it when the endpoint really does inject. A `true` against a bare SteelSwap base
   * sends unauthenticated requests to a partner-keyed API and every `/api/v2/*` call 401s.
   */
  readonly keyInjectedByEndpoint?: boolean
}

/**
 * Accounts we vouch for, addressed by **`pnyx_id`** rather than by name.
 *
 * ⚠️ **Highlight ours; do not police theirs.** Every script is allowed in a name and confusables are
 * deliberately not policed, so a denylist chasing "Support", "Ѕupport", "Suppоrt" and every combining
 * form is an unbounded list against an unbounded space. An id allowlist is bounded, auditable and
 * **unforgeable**: the mark attaches to a commitment nobody else can hold.
 *
 * ⚠️ **It does not stop anyone *calling* themselves "Pnyx Support"** — it only withholds the mark,
 * and absence of a mark is a weaker signal than its presence. {@link support} is the mitigation that
 * matters: an in-app entry point that opens the right conversation, so the common path never asks a
 * user to judge who answered.
 *
 * ⚠️⚠️ **Delivered over remote config, which is fetched unsigned.** That makes whoever controls the
 * endpoint able to mark an account official *and*, through {@link support}, to redirect support
 * conversations. Known and accepted; the id is the thing to protect if that trade is revisited.
 */
export type RemoteOfficialConfig = {
  /**
   * Every `pnyx_id` that renders with the official mark. One tier, deliberately — `official` and
   * nothing else until a second kind of vouching actually exists.
   */
  readonly identities?: readonly string[]
  /** The `pnyx_id` the "Ask support" action opens a conversation with. Must also appear in {@link identities}. */
  readonly support?: string
}

export type RemoteConfig = {
  readonly official?: RemoteOfficialConfig
  readonly banners?: ReadonlyArray<RemoteBanner>
  readonly swap?: RemoteSwapConfig
  readonly dapps?: RemoteDappConfig
  readonly features?: Partial<FeatureFlagsConfig>
  readonly maintenance?: RemoteMaintenanceConfig
  readonly allowedLinks?: RemoteAllowedNotificationLinks
  readonly networks?: RemoteNetworksConfig
}

/**
 * Build environment — maps 1:1 to the per-environment JSON files served by
 * the remote-config endpoint.
 */
export type RemoteConfigEnv = 'dev' | 'preview' | 'prod'

/**
 * Options for building the remote config URL.
 */
export type RemoteConfigUrlOptions = {
  /** Base URL for the config repository raw content */
  readonly baseUrl: string
  /** Environment to fetch config for */
  readonly env: RemoteConfigEnv
}

/**
 * Localhost fallback for local development when no explicit base URL is
 * configured. Real builds set `EXPO_PUBLIC_REMOTE_CONFIG_URL` in the brand
 * env files (see `app/brands/<brand>/config/env/`).
 */
const DEFAULT_BASE_URL = 'http://localhost:8790/remote-config'

// Local shadow declaration: this package compiles without node types (it is
// consumed by the React Native bundle, where Expo provides `process.env`).
declare const process: {readonly env?: Readonly<Record<string, string | undefined>>} | undefined

// Keep the `process.env.EXPO_PUBLIC_*` member expression literal — Expo's
// babel preset inlines it at bundle time.
const readEnvBaseUrl = (): string | undefined =>
  typeof process === 'undefined' || !process?.env ? undefined : process.env.EXPO_PUBLIC_REMOTE_CONFIG_URL

const getRemoteConfigBaseUrl = (baseUrl?: string): string => baseUrl ?? readEnvBaseUrl() ?? DEFAULT_BASE_URL

/**
 * Builds the remote config URL for the given options.
 *
 * @param options - URL building options (baseUrl and env)
 * @returns The full URL to fetch config from
 */
export const getRemoteConfigUrl = (options?: Partial<RemoteConfigUrlOptions>): string => {
  // Default to 'prod' — this function is a pure utility with no access to
  // build-time context, so it must be safe to call without arguments. Prod is
  // the safe fallback: a misconfigured caller silently fetches prod config
  // rather than accidentally pointing a production build at dev data.
  const env = options?.env ?? 'prod'
  return `${getRemoteConfigBaseUrl(options?.baseUrl)}/${env}.json`
}

/**
 * Builds a raw asset URL for files stored in the config repository.
 *
 * @param path - Repository-relative asset path
 * @param options - Optional base URL override
 * @returns The full URL to fetch the asset from
 */
export const getRemoteConfigAssetUrl = (
  path: string,
  options?: Pick<Partial<RemoteConfigUrlOptions>, 'baseUrl'>,
): string => {
  return `${getRemoteConfigBaseUrl(options?.baseUrl)}/${path.replace(/^\/+/, '')}`
}

/**
 * Fetches remote configuration from the given URL.
 *
 * @param url - Full URL to fetch JSON config from
 * @returns Effect containing the parsed remote config or ConfigLoadError
 */
export const fetchRemoteConfig = (url: string): Effect.Effect<RemoteConfig, ConfigLoadError> =>
  Effect.tryPromise({
    try: async () => {
      // Never served from an HTTP cache. The objects carry `max-age=300` so the
      // CDN can do its job, but React Native's OkHttp client keeps its own
      // on-disk response cache and will happily hand back a stale body — which
      // is how a published config reached the device's browser but not the app,
      // with the fetch still logging success. The app already does
      // stale-while-revalidate itself against `@pnyx/remote-config-cache`, so an
      // HTTP-layer copy adds nothing and hides the thing it caches.
      const response = await fetch(url, {cache: 'no-store', headers: {'Cache-Control': 'no-cache'}})
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      return (await response.json()) as RemoteConfig
    },
    catch: (error) =>
      new ConfigLoadError({
        message: `Failed to fetch remote config from ${url}`,
        cause: error,
      }),
  })

/**
 * Extracts feature flags from a remote config.
 *
 * @param config - Remote config (may be undefined if fetch failed)
 * @returns Feature flags config, or undefined if not available
 */
export const getRemoteFeatureFlags = (config: RemoteConfig | undefined): FeatureFlagsConfig | undefined =>
  config?.features

/**
 * Extracts dapps configuration from a remote config.
 *
 * @param config - Remote config (may be undefined if fetch failed)
 * @returns DApps config, or undefined if not available
 */
export const getRemoteDapps = (config: RemoteConfig | undefined): RemoteDappConfig | undefined => config?.dapps

/**
 * Extracts maintenance flags from a remote config.
 *
 * @param config - Remote config (may be undefined if fetch failed)
 * @returns Maintenance flags record, or undefined if not available
 */
export const getMaintenanceFlags = (config: RemoteConfig | undefined): RemoteMaintenanceConfig | undefined =>
  config?.maintenance

/**
 * Extracts allowed links from a remote config.
 *
 * @param config - Remote config (may be undefined if fetch failed)
 * @returns Allowed links record, or undefined if not available
 */
/**
 * Extracts the per-chain, per-network rules from a remote config.
 *
 * Returns `undefined` when the control plane says nothing, which every caller must read as "use the
 * built-in endpoints and treat every network as available" rather than as "everything is off".
 */
export const getNetworkRules = (config: RemoteConfig | undefined): RemoteNetworksConfig | undefined => config?.networks

/**
 * The rule for one (chain, network) pair, or `undefined` when the control plane has no opinion.
 */
export const getNetworkRule = (
  config: RemoteConfig | undefined,
  chain: RemoteChain,
  network: RemoteNetworkName,
): RemoteNetworkRule | undefined => config?.networks?.[chain]?.[network]

export const getAllowedLinks = (config: RemoteConfig | undefined): RemoteAllowedNotificationLinks | undefined =>
  config?.allowedLinks

/**
 * The SteelSwap partner key the control plane published, or `undefined` for "this build has none".
 *
 * Blank is absent: an empty string would read as a configured credential and authenticate nothing,
 * which is the one failure that looks like a working swap paying the wrong principal.
 */
export const getRemoteSwapPartnerKey = (config: RemoteConfig | undefined): string | undefined => {
  const key = config?.swap?.partnerApiKey?.trim()
  return key === undefined || key === '' ? undefined : key
}

/**
 * Whether the published swap endpoint injects the partner credential itself.
 *
 * Defaults to `false`, which is the safe direction: a config that fails to load, or one written by
 * a future version in a shape this build does not understand, must leave the app acquiring its own
 * key rather than silently sending none to an API that requires one.
 */
export const getRemoteSwapKeyInjectedByEndpoint = (config: RemoteConfig | undefined): boolean =>
  config?.swap?.keyInjectedByEndpoint === true

/**
 * Extracts banners from a remote config.
 *
 * Filters banners by date range (if specified).
 *
 * @param config - Remote config (may be undefined if fetch failed)
 * @returns Array of active banners
 */
export const getBanners = (
  config: RemoteConfig | undefined,
  platform?: RemoteBannerPlatform,
): ReadonlyArray<RemoteBanner> => {
  if (!config?.banners) return []
  const now = Date.now()
  return config.banners
    .map((banner) => {
      const override = platform ? banner.platformOverrides?.[platform] : undefined
      if (!override) return banner

      const {contentId, type, imageUrl, ctaLink, startDate, endDate, isDismissible, priorityWeight} = override

      return {
        ...banner,
        ...(contentId === undefined ? {} : {contentId}),
        ...(type === undefined ? {} : {type}),
        ...(imageUrl === undefined ? {} : {imageUrl}),
        ...(ctaLink === undefined ? {} : {ctaLink}),
        ...(startDate === undefined ? {} : {startDate}),
        ...(endDate === undefined ? {} : {endDate}),
        ...(isDismissible === undefined ? {} : {isDismissible}),
        ...(priorityWeight === undefined ? {} : {priorityWeight}),
      }
    })
    .filter((banner) => {
      if (banner.startDate && now < new Date(banner.startDate).getTime()) return false
      if (banner.endDate && now > new Date(banner.endDate).getTime()) return false
      return true
    })
    .sort((a, b) => b.priorityWeight - a.priorityWeight)
}
