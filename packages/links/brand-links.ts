/**
 * Brand-specific deep link parser and builder.
 *
 * Handles versioned partner links that use the brand scheme (pnyx://) or
 * HTTPS fallback (https://pnyx.pxkq.uk/w1/...).
 *
 * @module
 */

import type {
  BrandAction,
  BrowserLaunchDappUrl,
  ExchangeShowCreateResult,
  PartnerInfo,
  TransferRequestAda,
  TransferRequestAdaWithLink,
  TransferRequestCrypto,
  TransferTarget,
} from './brand-types.js'
import {normalizeTransferRequestCrypto} from './transfer-normalization.js'

export const PNYX_AUTHORITY = 'pnyx.pxkq.uk'
export const PNYX_SCHEME = 'pnyx'
export const BRAND_LINK_AUTHORITIES = [PNYX_AUTHORITY] as const

const VERSION = 'w1'

/**
 * Supported brand link prefixes.
 * The brand scheme (e.g. "pnyx") is dynamic per build configuration.
 */
const HTTPS_PREFIXES = BRAND_LINK_AUTHORITIES.map((authority) => `https://${authority}/${VERSION}/`)

const isBrandAuthority = (hostname: string): boolean => (BRAND_LINK_AUTHORITIES as readonly string[]).includes(hostname)

const isBrandProtocol = (url: URL, brandScheme: string): boolean => url.protocol === `${brandScheme}:`

/**
 * URLSearchParams decodes the query value once. New links store `redirectTo`
 * raw and let URLSearchParams do the wrapping. Older links pre-encoded it
 * before URLSearchParams, so after one automatic decode the whole target still
 * looks like an encoded URL/path. Decode only that legacy wrapper layer and
 * keep nested callback params opaque.
 */
const normalizeRedirectTo = (value: string): string => {
  if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value)) return value

  try {
    const decoded = decodeURIComponent(value)
    return /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(decoded) ? decoded : value
  } catch {
    return value
  }
}

/**
 * Check if a URL string is a brand-specific link.
 */
export const isBrandLink = (uri: string, brandScheme?: string): boolean => {
  if (HTTPS_PREFIXES.some((prefix) => uri.startsWith(prefix))) return true
  if (brandScheme && uri.startsWith(`${brandScheme}://`)) return true
  return false
}

/**
 * Convert URL search params to a typed object, handling JSON-encoded values
 * and array params (e.g. targets[0], targets[1]).
 */
const paramsToObject = (params: URLSearchParams): Record<string, unknown> => {
  const obj: Record<string, unknown> = {}

  for (const [rawKey, rawValue] of params) {
    const value = decodeURIComponent(rawValue)
    const arrayMatch = rawKey.match(/^(.+)\[(\d+)\]$/)
    const key = arrayMatch ? (arrayMatch[1] ?? rawKey) : rawKey

    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      parsed = value
    }

    if (arrayMatch) {
      if (!Array.isArray(obj[key])) {
        obj[key] = []
      }
      ;(obj[key] as unknown[]).push(parsed)
    } else if (key in obj) {
      const existing = obj[key]
      if (Array.isArray(existing)) {
        existing.push(parsed)
      } else {
        obj[key] = [existing, parsed]
      }
    } else {
      obj[key] = parsed
    }
  }

  return obj
}

/**
 * Extract the versioned path from a brand link URL.
 * Returns the path after /w1/ or null if not a valid brand link.
 */
const extractPath = (url: URL, brandScheme?: string): string | null => {
  // HTTPS: https://<brand-authority>/w1/<path>
  if (url.protocol === 'https:' && isBrandAuthority(url.hostname)) {
    const match = url.pathname.match(/^\/w1\/(.+)$/)
    return match?.[1] ?? null
  }

  // Brand scheme: <scheme>://<brand-authority>/w1/<path>
  if (brandScheme && isBrandProtocol(url, brandScheme)) {
    // hostname is a brand link authority, pathname is /w1/<path>
    if (isBrandAuthority(url.hostname)) {
      const match = url.pathname.match(/^\/w1\/(.+)$/)
      return match?.[1] ?? null
    }
  }

  return null
}

/**
 * Extract partner info fields from params object
 */
const extractPartnerInfo = (obj: Record<string, unknown>, params?: URLSearchParams): PartnerInfo => {
  const info: Record<string, unknown> = {}
  if (typeof obj.client === 'string') info.client = obj.client
  if (typeof obj.isSandbox === 'boolean') info.isSandbox = obj.isSandbox
  if (typeof obj.isTestnet === 'boolean') info.isTestnet = obj.isTestnet
  if (typeof obj.appId === 'string') info.appId = obj.appId
  if (typeof obj.message === 'string') info.message = obj.message
  if (typeof obj.authorization === 'string') info.authorization = obj.authorization
  if (typeof obj.signature === 'string') info.signature = obj.signature
  if (typeof obj.callbackPlatform === 'string') info.callbackPlatform = obj.callbackPlatform
  if (typeof obj.sourceWalletGroupId === 'string') info.sourceWalletGroupId = obj.sourceWalletGroupId
  if (typeof obj.sourceWalletAccountIndex === 'string' || typeof obj.sourceWalletAccountIndex === 'number') {
    info.sourceWalletAccountIndex = String(obj.sourceWalletAccountIndex)
  }
  const redirectTo = params?.get('redirectTo') ?? (typeof obj.redirectTo === 'string' ? obj.redirectTo : undefined)
  if (redirectTo) info.redirectTo = normalizeRedirectTo(redirectTo)
  return info as PartnerInfo
}

/**
 * Parse a brand-specific link into a BrandAction.
 *
 * @param uri - The full URI string
 * @param brandScheme - The brand scheme (e.g. "pnyx") to match against
 * @returns Parsed BrandAction or null if not a valid brand link
 */
export const parseBrandLink = (uri: string, brandScheme?: string): BrandAction | null => {
  let url: URL
  try {
    url = new URL(uri)
  } catch {
    return null
  }

  const path = extractPath(url, brandScheme)
  if (!path) return null

  const obj = paramsToObject(url.searchParams)
  const partnerInfo = extractPartnerInfo(obj, url.searchParams)

  switch (path) {
    case 'transfer/request/ada': {
      const targets = obj.targets as TransferTarget[] | undefined
      if (!Array.isArray(targets) || targets.length === 0) return null

      const params: TransferRequestAda = {
        ...partnerInfo,
        targets,
        ...(typeof obj.memo === 'string' && {memo: obj.memo}),
      }
      return {feature: 'transfer', useCase: 'request/ada', params}
    }

    case 'transfer/request/ada-with-link': {
      const link = typeof obj.link === 'string' ? decodeURIComponent(obj.link) : undefined
      if (!link) return null

      const params: TransferRequestAdaWithLink = {
        ...partnerInfo,
        link,
      }
      return {feature: 'transfer', useCase: 'request/ada-with-link', params}
    }

    case 'transfer/request/crypto': {
      const chain = typeof obj.chain === 'string' ? obj.chain : undefined
      const address = typeof obj.address === 'string' ? obj.address : undefined
      if (!chain || !address) return null
      const amount = url.searchParams.get('amount') || undefined

      const params = normalizeTransferRequestCrypto({
        ...partnerInfo,
        chain,
        address,
        ...(amount && {amount}),
        ...(typeof obj.token === 'string' && {token: obj.token}),
        ...(typeof obj.asset === 'string' && {asset: obj.asset}),
        ...(typeof obj.name === 'string' && {name: obj.name}),
      })
      if (params.amount && !/^\d+$/.test(params.amount)) return null
      return {feature: 'transfer', useCase: 'request/crypto', params}
    }

    case 'exchange/order/show-create-result': {
      const provider = obj.provider as string | undefined
      const orderType = obj.orderType as 'buy' | 'sell' | undefined
      if (!provider || !orderType) return null

      const params: ExchangeShowCreateResult = {
        ...partnerInfo,
        provider,
        orderType,
        ...(typeof obj.coinAmount === 'number' && {coinAmount: obj.coinAmount}),
        ...(typeof obj.coin === 'string' && {coin: obj.coin}),
        ...(typeof obj.fiatAmount === 'number' && {fiatAmount: obj.fiatAmount}),
        ...(typeof obj.fiat === 'string' && {fiat: obj.fiat}),
        ...(typeof obj.status === 'string' && {status: obj.status as 'success' | 'pending' | 'failed'}),
      }
      return {feature: 'exchange', useCase: 'order/show-create-result', params}
    }

    case 'multisig/cosigner-key': {
      const key = typeof obj.key === 'string' ? obj.key : undefined
      if (!key) return null
      // `name` and `accountIndex` are read only so a link from an older build
      // still parses. Nothing downstream acts on either — see MultisigCoSignerKey.
      const name = typeof obj.name === 'string' ? obj.name : undefined
      const accountIndex =
        typeof obj.accountIndex === 'number' && Number.isInteger(obj.accountIndex) && obj.accountIndex >= 0
          ? obj.accountIndex
          : undefined
      return {
        feature: 'multisig',
        useCase: 'cosigner-key',
        params: {
          ...partnerInfo,
          key,
          ...(name === undefined ? {} : {name}),
          ...(accountIndex === undefined ? {} : {accountIndex}),
        },
      }
    }

    case 'multisig/invite':
      // No fields to check: a request for a key carries nothing. An older link's
      // walletName/fromName/inviteId are simply not read.
      return {feature: 'multisig', useCase: 'invite', params: {...partnerInfo}}

    case 'multisig/wallet': {
      const def = typeof obj.def === 'string' ? obj.def : undefined
      if (!def) return null
      return {feature: 'multisig', useCase: 'wallet', params: {...partnerInfo, def}}
    }

    case 'dm/invite': {
      const permit = typeof obj.permit === 'string' ? obj.permit : undefined
      if (!permit) return null
      return {feature: 'dm', useCase: 'invite', params: {...partnerInfo, permit}}
    }

    case 'browser/launch': {
      const dappUrl = typeof obj.dappUrl === 'string' ? decodeURIComponent(obj.dappUrl) : undefined
      if (!dappUrl) return null

      const params: BrowserLaunchDappUrl = {
        ...partnerInfo,
        dappUrl,
      }
      return {feature: 'browser', useCase: 'launch', params}
    }

    default:
      return null
  }
}

/**
 * Schemes accepted by {@link buildBrandLink}: the app scheme (`'pnyx'`) or
 * `'https'` for the HTTPS fallback that relies on the PNYX_AUTHORITY domain.
 */
export type BrandLinkScheme = typeof PNYX_SCHEME | 'https'

/**
 * Build a brand-specific link URL.
 *
 * @param action - The brand action to build a URL for
 * @param scheme - The scheme to use ({@link BrandLinkScheme})
 * @returns The built URL string
 */
export const buildBrandLink = (action: BrandAction, scheme: BrandLinkScheme): string => {
  const authority = PNYX_AUTHORITY
  const base = `${scheme}://${authority}/${VERSION}/${action.feature}/${action.useCase}`
  const params = new URLSearchParams()

  const addPartnerInfo = (info: PartnerInfo) => {
    if (info.client) params.set('client', info.client)
    if (info.isSandbox !== undefined) params.set('isSandbox', String(info.isSandbox))
    if (info.isTestnet !== undefined) params.set('isTestnet', String(info.isTestnet))
    if (info.appId) params.set('appId', info.appId)
    if (info.message) params.set('message', info.message)
    if (info.authorization) params.set('authorization', info.authorization)
    if (info.signature) params.set('signature', info.signature)
    if (info.callbackPlatform) params.set('callbackPlatform', info.callbackPlatform)
    if (info.sourceWalletGroupId) params.set('sourceWalletGroupId', info.sourceWalletGroupId)
    if (info.sourceWalletAccountIndex) params.set('sourceWalletAccountIndex', info.sourceWalletAccountIndex)
    if (info.redirectTo) params.set('redirectTo', info.redirectTo)
  }

  switch (action.useCase) {
    case 'request/ada': {
      const p = action.params
      addPartnerInfo(p)
      p.targets.forEach((target, i) => {
        params.set(`targets[${i}]`, JSON.stringify(target))
      })
      if (p.memo) params.set('memo', p.memo)
      break
    }
    case 'request/ada-with-link': {
      const p = action.params
      addPartnerInfo(p)
      params.set('link', encodeURIComponent(p.link))
      break
    }
    case 'request/crypto': {
      const p = normalizeTransferRequestCrypto(action.params)
      addPartnerInfo(p)
      params.set('chain', p.chain)
      params.set('address', p.address)
      if (p.amount) params.set('amount', p.amount)
      if (p.token) params.set('token', p.token)
      const asset = p.asset ?? p.name
      if (asset) params.set('asset', asset)
      break
    }
    case 'order/show-create-result': {
      const p = action.params
      addPartnerInfo(p)
      params.set('provider', p.provider)
      params.set('orderType', p.orderType)
      if (p.coinAmount !== undefined) params.set('coinAmount', String(p.coinAmount))
      if (p.coin) params.set('coin', p.coin)
      if (p.fiatAmount !== undefined) params.set('fiatAmount', String(p.fiatAmount))
      if (p.fiat) params.set('fiat', p.fiat)
      if (p.status) params.set('status', p.status)
      break
    }
    case 'launch': {
      const p = action.params
      addPartnerInfo(p)
      params.set('dappUrl', encodeURIComponent(p.dappUrl))
      break
    }
    case 'cosigner-key': {
      const p = action.params
      addPartnerInfo(p)
      params.set('key', p.key)
      break
    }
    case 'wallet': {
      const p = action.params
      addPartnerInfo(p)
      params.set('def', p.def)
      break
    }
    // ⚠️ Two features share the `invite` use case, so this arm has to discriminate on the feature as
    // well — switching on `useCase` alone silently mixed a DM invite's params into a multisig one.
    case 'invite': {
      if (action.feature === 'dm') {
        const p = action.params
        addPartnerInfo(p)
        params.set('permit', p.permit)
        break
      }
      // A multisig invite has no fields of its own.
      addPartnerInfo(action.params)
      break
    }
  }

  const query = params.toString()
  return query ? `${base}?${query}` : base
}

/**
 * Convenience builder for partner integrations that need to request a wallet
 * transfer on a concrete chain.
 *
 * Use this for Encryptus-style off-ramp deposit requests and any other partner
 * flow that hands the user a "pay X to address Y on chain Z" intent. Works for
 * both native (ADA / ETH) and token sends in one signature — preferred over
 * the legacy `transfer.request.adaWithLink` flow that required wrapping a
 * CIP-13 `web+cardano://` URI.
 *
 * Encoding rules (subtle, get them wrong and the wallet rejects the link):
 *   - `amount` is a **base-unit integer string**: lovelace for ADA
 *     (`'2000000'` = 2 ADA), wei for ETH (`'50000000000000000'` = 0.05 ETH),
 *     or token base units for ERC-20s (`'5050000'` = 5.05 USDC).
 *   - `redirectTo` is a **raw HTTPS URL** — do NOT pre-`encodeURIComponent`
 *     it. The builder applies URLSearchParams encoding once. Nested partner
 *     query params (e.g. `?orderId=...&coinType=...`) round-trip cleanly.
 *   - `token` is the asset identifier for non-native sends (EVM contract
 *     address or Cardano `policyId.assetNameHex`). Omit for native ADA/ETH.
 *   - `asset` is passive display metadata; consumers may ignore it.
 *   - `callbackPlatform` is a partner hint for choosing the return protocol:
 *     `'app'` for the native app deep link (`pnyx://...`).
 *
 * @param params - The transfer request payload. See {@link TransferRequestCrypto}.
 * @param options.scheme - Brand scheme to embed in the URI. Defaults to
 *   `'pnyx'`. Use `'https'` for the universal HTTPS fallback
 *   (`https://pnyx.pxkq.uk/w1/...`).
 *
 * @example Cardano ADA payment, $25 in lovelace, custom callback
 * ```ts
 * buildTransferRequestCryptoLink({
 *   chain: 'cardano:mainnet',
 *   asset: 'ADA',
 *   address: 'addr1qy62rec...',
 *   amount: '25000000',
 *   redirectTo: 'https://hub.encryptus.co/pw/?orderId=ORDER123&orderType=sell',
 *   appId: '18d1545a-a59b-45cb-a180-157b110c77fe',
 * })
 * // → 'pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto?chain=cardano%3Amainnet&...'
 * ```
 *
 * @example Ethereum ETH payment with redirect to current page
 * ```ts
 * buildTransferRequestCryptoLink({
 *   chain: 'eip155:1',
 *   address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
 *   amount: '50000000000000000', // 0.05 ETH
 *   redirectTo: window.location.href,
 * })
 * ```
 *
 * @example Ethereum USDC payment, 5.05 USDC in token base units
 * ```ts
 * buildTransferRequestCryptoLink({
 *   client: 'encryptus',
 *   chain: 'ETHEREUM',
 *   name: 'USDC',
 *   address: '0x742d35Cc6634C0532925a3b844Bc454e4438f44e',
 *   amount: '5050000',
 * })
 * ```
 */
export const buildTransferRequestCryptoLink = (
  params: TransferRequestCrypto,
  options: {readonly scheme?: BrandLinkScheme} = {},
): string => buildBrandLink({feature: 'transfer', useCase: 'request/crypto', params}, options.scheme ?? 'pnyx')
