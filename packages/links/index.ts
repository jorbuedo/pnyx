/**
 * @pnyx/links - Cardano URI parsing and brand-specific deep link handling
 *
 * Cardano URIs (web+cardano://):
 * - claim, watch, browse, pay/payment, stake, drep, transaction, block, address, connect, wallet, legacy-transfer
 * - Legacy CIP-13 bare address format: web+cardano:<address>?amount=...
 *
 * Brand-specific links (pnyx://, https://pnyx.pxkq.uk/w1/):
 * - transfer/request/ada: Multi-target payment request
 * - transfer/request/ada-with-link: Payment with embedded Cardano link
 * - transfer/request/crypto: Chain-aware payment request
 * - exchange/order/show-create-result: Exchange order result
 * - browser/launch: Launch dApp URL
 *
 * @example
 * ```typescript
 * import { parse, build, isCardanoUri, parseBrandLink } from '@pnyx/links'
 * import { Effect } from 'effect'
 *
 * // Parse a Cardano URI
 * const result = await Effect.runPromise(
 *   parse('web+cardano://pay?address=addr1...&amount=1000000')
 * )
 *
 * // Parse a brand-specific link
 * const action = parseBrandLink('pnyx://pnyx.pxkq.uk/w1/browser/launch?dappUrl=...', 'pnyx')
 * ```
 */

// Authority modules for direct access
export * as Authorities from './authorities.js'
export type {BrandLinkScheme} from './brand-links.js'
// Brand link exports
export {
  BRAND_LINK_AUTHORITIES,
  buildBrandLink,
  buildTransferRequestCryptoLink,
  isBrandLink,
  PNYX_AUTHORITY,
  PNYX_SCHEME,
  parseBrandLink,
} from './brand-links.js'
// Brand link type exports
export type {
  BrandAction,
  BrowserLaunchDappUrl,
  ExchangeShowCreateResult,
  KnownTransferChain,
  MultisigCoSignerKey,
  MultisigInvite,
  MultisigWalletDefinition,
  PartnerCallbackPlatform,
  PartnerInfo,
  TransferRequestAda,
  TransferRequestAdaWithLink,
  TransferRequestClient,
  TransferRequestCrypto,
  TransferTarget,
} from './brand-types.js'
// Brand link constants
export {KNOWN_TRANSFER_CHAINS, TRANSFER_REQUEST_CLIENTS} from './brand-types.js'
// Error exports
export {InvalidUriError} from './errors.js'
// Main parser exports
export {build, isCardanoUri, parse} from './parser.js'
// Transfer request normalization exports
export {ETHEREUM_MAINNET_USDC_TOKEN, normalizeTransferRequestCrypto} from './transfer-normalization.js'
// Type exports
export type {
  AddressUri,
  BackupUri,
  BlockUri,
  BrowseUri,
  CardanoUri,
  ClaimUri,
  ConnectUri,
  DrepUri,
  LegacyTransferUri,
  ParsedUri,
  PayUri,
  PayV1Uri,
  RequestedAsset,
  StakeUri,
  TransactionUri,
  UriAuthority,
  WatchUri,
} from './types.js'
