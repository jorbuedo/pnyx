/**
 * `cardano-assets` — token metadata, icons, and fiat pricing for the Cardano
 * wallet UI (review, history, portfolio). SteelSwap-backed (self-service
 * anon-keyed), config-driven; unknown/unpriced degrades to absent — never faked.
 *
 * @module
 */

export {assetIdToUnit, unitToAssetId} from './asset-id'
export {isCexplorerPlaceholder} from './cexplorer-placeholder'
export {
  type CardanoAssetsConfig,
  getCardanoAssetsConfig,
  SUPPORTED_FIAT_CURRENCIES,
  steelswapQuoteCurrency,
} from './config'
export {
  type AssetFiat,
  rememberIconlessAsset,
  useAssetFiat,
  useTokenIconUri,
  useTokenInfos,
} from './hooks'
export {ftPlaceholderIconUri, knownTokenIconUri, nftPlaceholderIconUri} from './known-token-icons'
export {fetchAdaPrice, fetchTokenPrices} from './price'
export {
  fetchMetadata,
  fetchTokenAdaPrices,
  SteelswapError,
  type SteelswapTokenMeta,
  tokenIconUrl,
} from './steelswap'
export {
  ADA_ASSET_IDS,
  ADA_TOKEN_INFO,
  adaTokenInfo,
  amountUnitFor,
  displayDecimals,
  type FetchLike,
  fetchTokenInfos,
  type TokenInfo,
  TokenMetadataError,
  unknownTokenInfo,
} from './token-metadata'
