/**
 * `@pnyx/dapp-connector` — the mobile CIP-30 dApp rail: injected-provider
 * script for the in-app browser WebView, message resolver, wallet-side Cardano
 * handler (exact wire encodings via the injected `Codec`), session
 * manager, and partial-sign coverage checks.
 *
 * Signing/connection never happens silently: `enable`/`signTx`/`signData`
 * fail with typed sentinels the host app catches to drive its approval,
 * review-tx, and ceremony UI.
 *
 * @module
 */

export {
  type CardanoHandlerContext,
  type CardanoQueryContext,
  type CardanoUtxo,
  createCardanoHandler,
} from './cardano/handler.js'
export {verifyWitnessCoverage} from './cardano/partial-sign.js'
// CIP-139 chain reads: satisfies the fork's query layer once and normalizes its
// failures to the wire error type.
export {makeCardanoQueryContext, type QueryLayers} from './cardano/query-context.js'
export {
  MAX_TARGET_ASSETS,
  parseValueTarget,
  selectUtxosForTarget,
  type ValueTarget,
} from './cardano/utxo-selection.js'
export {
  generateInjectionScript,
  type InjectionConfig,
  MIDNIGHT_API_VERSION,
  MIDNIGHT_WALLET_RDNS,
  MIDNIGHT_WALLET_UUID,
  RESPONSE_CALLBACK,
} from './injection.js'
export {
  type DappSession,
  DEFAULT_SESSION_TTL_MS,
  InMemorySessionStore,
  isInvalidSessionOrigin,
  isSessionExpired,
  makeInMemorySessionStore,
  makeSessionManager,
  normalizeOrigin,
  parseDappSession,
  SESSION_MAX_AGE_MS,
  type SessionManager,
  type SessionStore,
  SessionStoreError,
  SessionStoreTag,
} from './manager.js'
export {
  APP_SECRET_LENGTH,
  APP_SECRET_V1,
  appSecretInfo,
  appSecretSalt,
  MAX_APP_SECRET_DOMAIN,
  readAppSecretRequest,
} from './midnight/app-secret.js'
// The Midnight connector: the same bridge, a second chain. No mobile Midnight connector exists
// anywhere else, extension or otherwise.
export {createMidnightHandler, type MidnightHandlerContext} from './midnight/handler.js'
export {
  MIDNIGHT_SIGNATURE_SCHEME,
  MIDNIGHT_SIGNED_MESSAGE_PREFIX,
  readSignDataRequest,
  type SignDataRead,
  signatureResult,
  signedMessageBytes,
} from './midnight/sign-data.js'
export {
  MAX_TRANSFER_OUTPUTS,
  readTransferRequest,
  type TransferOutput,
  type TransferRead,
  type TransferRequest,
} from './midnight/transfer.js'
export {historyEntriesOf, txStatusOf, type WalletTransaction} from './midnight/tx-status.js'
export {
  type ChainHandler,
  createResolver,
  invalidRequest,
  type MethodHandler,
  type RequestContext,
  type Resolver,
  type ResolverConfig,
  refused,
} from './resolver.js'
export {
  ApiErrorCode,
  CHAIN_TYPES,
  type ChainType,
  ConnectionRequired,
  type DappError,
  type DappMessage,
  DataSignErrorCode,
  isChainType,
  MidnightAppSecretRequired,
  MidnightBalanceRequired,
  type MidnightErrorCode,
  MidnightSignDataRequired,
  MidnightSubmitRequired,
  MidnightTransferRequired,
  type SentinelError,
  SignDataRequired,
  SignTxRequired,
  TxSendErrorCode,
  TxSignErrorCode,
  type WalletResponse,
  WireError,
} from './types.js'
