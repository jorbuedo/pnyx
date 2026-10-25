import {Brand} from 'effect'

/**
 * Cardano URI - a branded string representing a web+cardano:// URI
 */
export type CardanoUri = string & Brand.Brand<'CardanoUri'>

export const CardanoUri = Brand.nominal<CardanoUri>()

/**
 * Supported URI authorities
 */
export type UriAuthority =
  | 'claim'
  | 'watch'
  | 'browse'
  | 'pay'
  | 'payment'
  | 'stake'
  | 'drep'
  | 'transaction'
  | 'block'
  | 'address'
  | 'connect'
  | 'backup'
  | 'legacy-transfer'
  | 'pay-v1'

/**
 * Claim URI — faucet token claims, per **CIP-99 (Proof of Onboarding)**, which is
 * the separate CIP that CIP-13's `claim` example points at.
 *
 * Format: `web+cardano://claim/v1?faucet_url=<https url>&code=<code>[&…]`
 */
export type ClaimUri = {
  readonly authority: 'claim'
  readonly version: string
  /** Validated as `https:`, then carried exactly as received — see `authorities/claim.ts`. */
  readonly faucetUrl: string
  readonly code: string
  /**
   * Every other query parameter, which CIP-99 requires be forwarded to the faucet
   * unmodified — its own examples carry `invoice` and `user_id`.
   */
  readonly params: Readonly<Record<string, string>>
}

/**
 * Watch URI — hand off an address to track as a watch-only wallet.
 *
 * Format: `web+cardano://watch/v1?address=<addr1…|stake1…>&name=<label>`
 *
 * Defined by this project rather than by a CIP; see `authorities/watch.ts` for
 * why, and for why this is the one hand-off safe to act on from a message.
 */
export type WatchUri = {
  readonly authority: 'watch'
  readonly version: string
  /** A payment, stake or single address. Not validated here — no codec in this package. */
  readonly address: string
  /** Optional wallet label. Absent when unset, blank, or implausibly long. */
  readonly name?: string
}

/**
 * Browse URI — CIP-0158: hand-off to the wallet's embedded browser.
 *
 * Format: `web+cardano://browse/v1?uri=<percent_encoded_https_url>`.
 * The wallet opens `uri` in its embedded browser / app view.
 *
 * `uri` is constrained to `http:` and `https:` (strict, no JS / file / brand
 * schemes) by the parser, so consumers can route it straight to the in-app
 * browser without further validation.
 */
export type BrowseUri = {
  readonly authority: 'browse'
  readonly version: 'v1'
  readonly uri: string
}

/**
 * Pay URI - CIP-13 payment requests
 */
export type PayUri = {
  readonly authority: 'pay'
  readonly address: string
  readonly amount?: bigint
  readonly message?: string
}

/**
 * One native asset a payment request asks for — CIP-157 `t=`.
 *
 * `fingerprint` is a CIP-14 `asset1…` id, which is a **one-way hash** of
 * (policyId, assetName): it identifies an asset but cannot be turned back into the
 * pair a transaction output needs. A consumer has to match it against assets it
 * already knows, and must surface one it cannot place rather than dropping it.
 */
export type RequestedAsset = {
  readonly fingerprint: string
  /** Whole units. Absent in the URI means 1, which the parser fills in. */
  readonly quantity: bigint
}

/**
 * CIP-157 payment request — `web+cardano://pay/v1/<address>?l=&i=&n=&t=`.
 *
 * The CIP-13 extension that adds native assets, a payment identifier and a note.
 * Distinct from {@link PayUri} because the shapes differ: the address is in the path
 * here, and the amount key is `l` rather than `amount`.
 */
export type PayV1Uri = {
  readonly authority: 'pay-v1'
  readonly address: string
  /** Lovelace. Absent means the payer chooses. */
  readonly lovelace?: bigint
  /** An invoice or order reference the requester wants echoed back to them. */
  readonly paymentId?: string
  /** Percent-decoded, at most 64 characters — the CIP's own limit. */
  readonly note?: string
  readonly assets: readonly RequestedAsset[]
}

/**
 * Stake URI - stake pool delegation
 */
export type StakeUri = {
  readonly authority: 'stake'
  readonly poolId: string
}

/**
 * DRep URI - DRep delegation
 */
export type DrepUri = {
  readonly authority: 'drep'
  readonly drepId: string
}

/**
 * Transaction URI - view transaction
 */
export type TransactionUri = {
  readonly authority: 'transaction'
  readonly hash: string
}

/**
 * Block URI - view block
 */
export type BlockUri = {
  readonly authority: 'block'
  readonly hash: string
}

/**
 * Address URI - view address
 */
export type AddressUri = {
  readonly authority: 'address'
  readonly address: string
}

/**
 * Connect URI - wallet connect
 */
export type ConnectUri = {
  readonly authority: 'connect'
  readonly params: Record<string, string>
}

/**
 * Backup URI - encrypted wallet export/import (CIP-0301)
 */
export type BackupUri = {
  readonly authority: 'backup'
  readonly enc: string
  readonly params: Record<string, string>
}

/**
 * Legacy Transfer URI - Byron wallet transfer
 */
export type LegacyTransferUri = {
  readonly authority: 'legacy-transfer'
  readonly params: Record<string, string>
}

/**
 * Union of all parsed URI types
 */
export type ParsedUri =
  | ClaimUri
  | WatchUri
  | BrowseUri
  | PayUri
  | StakeUri
  | DrepUri
  | TransactionUri
  | BlockUri
  | AddressUri
  | ConnectUri
  | BackupUri
  | LegacyTransferUri
  | PayV1Uri
