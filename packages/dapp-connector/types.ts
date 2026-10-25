/**
 * dApp-connector domain types: the WebView bridge message shapes, CIP-30 wire
 * error codes, and the sentinel errors that route signing/connection requests
 * into the host app's UI instead of answering them silently.
 *
 * @module
 */

import type {ErrorCode as MidnightErrorCode} from '@midnight-ntwrk/dapp-connector-api'
import {Data} from 'effect'

export type {MidnightErrorCode}

/**
 * Chains the connector can serve.
 *
 * `midnight` speaks `@midnight-ntwrk/dapp-connector-api` over the same WebView bridge — no Midnight
 * wallet reachable from a phone exists anywhere else, extension or otherwise.
 */
export type ChainType = 'cardano' | 'midnight'

/**
 * Every `ChainType`, as a value — so a runtime check can be exhaustive rather than hand-listed.
 *
 * The assertion below is the point: adding a chain to the union without adding it here is a **compile
 * error**, not a session that silently fails to parse. This guard previously hardcoded `'cardano'`
 * while a comment beside it noted the stores had once claimed to accept `'midnight'` too — a mismatch
 * a doc cannot prevent and a type can.
 */
export const CHAIN_TYPES = ['cardano', 'midnight'] as const

type EveryChainTypeListed = Exclude<ChainType, (typeof CHAIN_TYPES)[number]> extends never ? true : never
const _everyChainTypeListed: EveryChainTypeListed = true
void _everyChainTypeListed

export const isChainType = (value: unknown): value is ChainType =>
  typeof value === 'string' && (CHAIN_TYPES as readonly string[]).includes(value)

/** A request posted by the injected provider over the WebView bridge. */
export type DappMessage = {
  readonly id: string
  readonly sessionId?: string
  readonly chainType: ChainType
  readonly method: string
  readonly params?: unknown
  /** `window.location.origin` of the requesting page. */
  readonly origin: string
}

/** CIP-30-shaped wire error delivered back to the dApp. */
export type DappError = {
  readonly code: number
  readonly message: string
  readonly data?: unknown
  /**
   * The Midnight connector's error code, when the request came from a Midnight page.
   *
   * `code` above is CIP-30's numeric one, and the two specs disagree: Midnight's `APIError` carries a
   * **string** code from a six-value union plus a `type` discriminator. Numbers cannot express it —
   * `-3` alone cannot say whether the user declined or the page was never granted permission — so the
   * chain-specific code travels beside it and the injected Midnight provider builds its own error from
   * this field. Absent for Cardano, which has no such union.
   */
  readonly apiCode?: MidnightErrorCode
}

/** The wallet's reply to one {@link DappMessage} (same `id`). */
export type WalletResponse = {
  readonly id: string
  readonly result?: unknown
  readonly error?: DappError
}

/** CIP-30 APIError codes. */
export const ApiErrorCode = {
  InvalidRequest: -1,
  InternalError: -2,
  Refused: -3,
  AccountChange: -4,
} as const

/** CIP-30 TxSignError codes. */
export const TxSignErrorCode = {
  ProofGeneration: 1,
  UserDeclined: 2,
} as const

/** CIP-30 DataSignError codes. */
export const DataSignErrorCode = {
  ProofGeneration: 1,
  AddressNotPK: 2,
  UserDeclined: 3,
} as const

/** CIP-30 TxSendError codes. */
export const TxSendErrorCode = {
  Refused: 1,
  Failure: 2,
} as const

/**
 * A handler failure that IS the dApp-facing wire error. The resolver folds it
 * into `WalletResponse.error` — it never escapes `resolve`.
 */
export class WireError extends Data.TaggedError('WireError')<{
  readonly code: number
  readonly message: string
  readonly data?: unknown
  /** See {@link DappError.apiCode} — set by the Midnight handler, ignored by the Cardano one. */
  readonly apiCode?: MidnightErrorCode
}> {}

// ── sentinels — typed failures the HOST APP catches to drive UI; never wire errors ──

/** `enable` from a not-yet-connected origin: show the connection approval UI. */
export class ConnectionRequired extends Data.TaggedError('ConnectionRequired')<{
  readonly origin: string
}> {}

/** `signTx`: route the tx into the review + signing ceremony. */
export class SignTxRequired extends Data.TaggedError('SignTxRequired')<{
  readonly txHex: string
  readonly partialSign: boolean
  readonly origin: string
}> {}

/** `signData` / `cip95_signData`: route the payload into the data-signing UI. */
export class SignDataRequired extends Data.TaggedError('SignDataRequired')<{
  readonly addressHex: string
  readonly payloadHex: string
  readonly origin: string
}> {}

/**
 * Midnight `signData`: route the payload into the data-signing UI.
 *
 * Separate from {@link SignDataRequired} because the two are not the same request. Cardano's is CIP-8 —
 * a COSE_Sign1 over Ed25519, with the address bound into a protected header. Midnight's is a bare
 * BIP-340 Schnorr signature over secp256k1 with no container and no address, so nothing about the
 * payload, the key, or the result is shared. Reusing one sentinel for both would put a `payloadHex`
 * through a signer that must not treat it as CIP-8.
 */
export class MidnightSignDataRequired extends Data.TaggedError('MidnightSignDataRequired')<{
  /** The bytes to sign, hex-encoded — already decoded from the dApp's `hex`/`base64`/`text` encoding. */
  readonly messageHex: string
  /** The payload exactly as the dApp sent it, to echo back in the result. */
  readonly data: string
  readonly origin: string
}> {}

/**
 * Midnight `makeTransfer`: route the request into the transfer-review UI.
 *
 * The wallet builds and signs a transfer here, so it is a funds signature and gets the same treatment
 * as one the send screen makes — the user sees what it does before a key is used. It is **not** a
 * submission: the bytes go back to the page.
 */
export class MidnightTransferRequired extends Data.TaggedError('MidnightTransferRequired')<{
  /** Values are `bigint` — a sentinel never crosses the JSON bridge, so nothing is lost here. */
  readonly outputs: readonly {
    readonly kind: 'shielded' | 'unshielded'
    readonly tokenType: string
    readonly value: bigint
    readonly recipient: string
  }[]
  /**
   * Whether the **wallet** covers the fee. `false` means the dApp intends to, so the wallet must build
   * a transaction that funds itself — which only the host can know it is able to do.
   */
  readonly payFees: boolean
  /**
   * Whether the host should submit after approval instead of answering with the bytes.
   *
   * Carried on the sentinel because only the host can submit, and the request is where the caller said
   * what it wanted — stashing it beside the call would be a second source of truth for one decision.
   */
  readonly submit: boolean
  readonly origin: string
}> {}

/**
 * Midnight `submitTransaction`: hand bytes to the submitting rail.
 *
 * A sentinel rather than a plain read because the host, not the resolver, holds the session the
 * sponsor requires. It carries no approval of its own: the transfer was approved when it was built,
 * and the host refuses bytes this wallet did not build (the sponsor pays the fee).
 */
export class MidnightSubmitRequired extends Data.TaggedError('MidnightSubmitRequired')<{
  readonly txHex: string
  readonly origin: string
}> {}

/**
 * Midnight `balanceUnsealedTransaction`: fund a transaction the dApp composed.
 *
 * A sentinel rather than an answer because this is the connector's strongest case for showing the user
 * what a request costs: the transaction is somebody else's, and what it takes from this wallet is only
 * knowable once the ledger has stated it. The host reads the deficit, names it on the review screen,
 * and only then signs.
 *
 * Only the hex travels. The transaction's own contents are not parsed here — that is the ledger's job,
 * natively, against the bytes.
 */
export class MidnightBalanceRequired extends Data.TaggedError('MidnightBalanceRequired')<{
  readonly txHex: string
  /** See {@link MidnightTransferRequired.payFees}. */
  readonly payFees: boolean
  readonly origin: string
}> {}

/**
 * Midnight `deriveAppSecret`: route the request into the approval UI.
 *
 * A seed-derived secret reaching web content is the most sensitive thing this connector does, so it
 * is approved per call like `signData` — and `origin` comes from the connection, never from the
 * request, because that binding is what stops one site asking for another's secret.
 */
export class MidnightAppSecretRequired extends Data.TaggedError('MidnightAppSecretRequired')<{
  readonly domain: string
  readonly origin: string
}> {}

export type SentinelError =
  | ConnectionRequired
  | SignTxRequired
  | SignDataRequired
  | MidnightSignDataRequired
  | MidnightTransferRequired
  | MidnightSubmitRequired
  | MidnightBalanceRequired
  | MidnightAppSecretRequired
