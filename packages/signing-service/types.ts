/**
 * Signing-service domain types — payloads, credentials, progress, results, errors.
 *
 * The payload union is deliberately chain-extensible: today only Cardano members
 * exist; a future chain adds its own `_tag` members here and a matching arm in
 * the service dispatch without touching the ports.
 *
 * @module
 */

import type {SecretText} from '@pnyx/crypto'
import type {CIP36RegistrationParams} from '@pnyx/hardware'
import {Data} from 'effect'

// ============================================================================
// Payloads
// ============================================================================

/**
 * A Cardano transaction to sign (and, unless `signOnly`, broadcast).
 *
 * `bodyHex` is the transaction body CBOR. The witness-set companions
 * (`nativeScripts` / `witnessExtra` / `auxHex`) come from the unsigned build
 * and are required to re-assemble a broadcastable tx; a `signOnly` request
 * (CIP-30 `signTx`) ignores them and returns just this signer's witness set.
 */
export type CardanoTxPayload = {
  readonly _tag: 'CardanoTx'
  readonly bodyHex: string
  readonly networkId: number
  /** 764824073 = mainnet, 1 = preprod, 2 = preview. Defaults by networkId. */
  readonly protocolMagic?: number
  /** Return a witness set instead of assembling + broadcasting (CIP-30 signTx). */
  readonly signOnly?: boolean
  /**
   * With {@link signOnly}, also assemble the full signed transaction and return it.
   *
   * For a caller that must hand the finished bytes to someone else to broadcast and therefore needs
   * the whole transaction rather than its own witnesses. ⚠️ Broadcasting such a transaction
   * ourselves would spend its nonce before that third party verifies it, so the two flags are
   * deliberately separate: this one never submits.
   *
   * ⚠️ **No caller sets this as of 2026-10-19.** Its only consumer was the x402 payment agent, which
   * was removed; it is kept because the adoption of `@x402/cardano` needs the same shape back (the
   * facilitator submits), not because something uses it today.
   */
  readonly assembleSignOnly?: boolean
  /** Multisig partial signing — skip the witness-coverage check. */
  readonly partial?: boolean
  /** Native scripts for the witness set (from the unsigned build). */
  readonly nativeScripts?: readonly string[]
  /** Raw witness-set map entries [key, CBOR hex] (plutus scripts/datums/redeemers). */
  readonly witnessExtra?: readonly (readonly [number, string])[]
  /**
   * Vkey witnesses the tx ALREADY carried when it was handed to us, to be kept
   * alongside ours in the assembled witness set.
   *
   * `witnessExtra` deliberately excludes witness-set key 0, because we normally
   * produce the whole vkey set. An externally-built tx that arrives
   * co-signed — a SteelSwap swap whose build answers `partialSign: true` — needs
   * its existing witness carried through, or it is broadcast one required
   * signature short.
   */
  readonly foreignVkeyWitnesses?: readonly {readonly vkeyHex: string; readonly sigHex: string}[]
  /** auxiliary_data CBOR (the tx's 4th element). */
  readonly auxHex?: string
  /** Signing paths resolved by the caller (dApp rail resolves before review). */
  readonly precomputedSigningPaths?: readonly string[]
  /** Required witness key hashes resolved by the caller. */
  readonly precomputedRequiredKeyHashes?: readonly string[]
  /** CIP-36 Catalyst registration (hardware only — devices sign the registration). */
  readonly cip36Registration?: CIP36RegistrationParams
}

/**
 * A CIP-8 / CIP-30 `signData` payload. The signing path must be resolved by
 * the caller (address-ownership → path; CIP-95 DRep credential → role 3).
 */
export type CardanoDataPayload = {
  readonly _tag: 'CardanoData'
  /** Raw address bytes, hex (CIP-30 wire form). */
  readonly addressHex: string
  /** Payload to sign, hex. */
  readonly payloadHex: string
  /** BIP-32 path of the key matching the address credential (e.g. `m/1852'/1815'/0'/0/0`). */
  readonly signingPath: string
  readonly networkId: number
  readonly protocolMagic?: number
  /**
   * Hardware ADDRESS-mode parameters. When present the device embeds the full
   * address in the COSE Sig_structure; absent → KEY_HASH mode (CIP-95 DRep).
   * Ignored for software signing (the address itself is embedded).
   */
  readonly hardwareAddressParams?: {
    readonly type: 'base' | 'reward' | 'enterprise'
    readonly spendingPath?: string
    readonly stakingPath?: string
  }
}

/** Chain-extensible payload union — Cardano only today. */
export type SigningPayload = CardanoTxPayload | CardanoDataPayload

/** One signing request: a payload signed on behalf of a wallet group. */
export type SigningRequest = {
  readonly payload: SigningPayload
  /** Wallet-group id — the credential store resolves material for it. */
  readonly groupId: string
  /** CIP-1852 account index. Defaults to 0. */
  readonly accountIndex?: number
}

// ============================================================================
// Credentials
// ============================================================================

/** In-process signing material (mnemonic-derived root, already decrypted by the vault). */
export type SoftwareCredential = {
  readonly kind: 'software'
  /**
   * BIP32-Ed25519 root extended private key, hex (192 hex chars: k‖c).
   *
   * Branded {@link SecretText}: this is the value that actually produces signatures, so it is the
   * one that most needs provenance. The brand is only mintable by a derivation from an already
   * branded `Mnemonic`, which the vault is the sole source of — so a credential cannot be
   * assembled from a string that never came through the vault (Phase 16 items 42–43).
   */
  readonly rootXprvHex: SecretText
}

/** A hardware device reference — signing happens on-device via the backend port. */
export type HardwareCredential = {
  readonly kind: 'hardware'
  readonly deviceType: 'ledger' | 'trezor'
  readonly bleDeviceId?: string
  readonly transportHint?: 'usb' | 'ble'
  /**
   * Account xpub recorded at import (pubkey‖chaincode, hex). When present the
   * service verifies the connected device derives the same xpub before signing.
   */
  readonly accountXpubHex?: string
}

export type ResolvedCredential = SoftwareCredential | HardwareCredential

export type SignerKind = ResolvedCredential['kind']

// ============================================================================
// Progress + results
// ============================================================================

/** Coarse progress phases surfaced to the review UI during a sign. */
export type SigningProgress = {
  readonly phase: 'resolving-keys' | 'connecting' | 'waiting-for-device' | 'signing' | 'assembling' | 'submitting'
}

export type TxSubmitted = {
  readonly _tag: 'TxSubmitted'
  readonly txHash: string
  readonly signedTxHex: string
}

export type TxSignedOnly = {
  readonly _tag: 'TxSignedOnly'
  /** TransactionWitnessSet CBOR hex (CIP-30 signTx result). */
  readonly witnessSetHex: string
  /** The assembled, unbroadcast transaction — present only when `assembleSignOnly` asked for it. */
  readonly signedTxHex?: string
}

export type DataSigned = {
  readonly _tag: 'DataSigned'
  /** COSE_Sign1, hex. */
  readonly signature: string
  /** COSE_Key, hex. */
  readonly key: string
}

export type SigningSuccess = TxSubmitted | TxSignedOnly | DataSigned

// ============================================================================
// Errors
// ============================================================================

/** Credential material could not be resolved (locked vault, unknown group…). */
export class SigningCredentialError extends Data.TaggedError('SigningCredentialError')<{
  readonly groupId: string
  readonly reason: string
}> {}

/** A hardware-device step failed (connect, verify, on-device sign, user reject). */
export class SigningDeviceError extends Data.TaggedError('SigningDeviceError')<{
  readonly reason: string
  readonly cause?: unknown
  /** True when the user declined on the device. */
  readonly userRejected?: boolean
  /**
   * True when the device was locked, which is a thing the user can fix in seconds — unlike every
   * other device failure. A flag rather than a string match, because the surface has to tell them
   * so: a 2026-10-08 Ledger report showed three attempts, each reported as a bare
   * "Transaction failed" with no mention of the lock the app had already detected.
   */
  readonly deviceLocked?: boolean
}> {}

/**
 * A witness-level failure: either the collected witnesses do not cover the
 * transaction's required key hashes (`missingKeyHashes`), or a produced witness
 * signature does not verify against the reviewed tx body hash (`reason`).
 */
export class SigningWitnessError extends Data.TaggedError('SigningWitnessError')<{
  readonly missingKeyHashes: readonly string[]
  readonly reason?: string
}> {}

/** The payload is malformed or its signing context could not be resolved. */
export class SigningPayloadError extends Data.TaggedError('SigningPayloadError')<{
  readonly reason: string
  readonly cause?: unknown
}> {}

/** Broadcast of the assembled tx was rejected / failed. */
export class SigningBroadcastError extends Data.TaggedError('SigningBroadcastError')<{
  readonly reason: string
  readonly cause?: unknown
}> {}

export type SigningError =
  | SigningCredentialError
  | SigningDeviceError
  | SigningWitnessError
  | SigningPayloadError
  | SigningBroadcastError

/**
 * `signAll` failure: carries what already succeeded (legs are broadcast as they
 * complete — there is no rollback) plus the failing leg's index and error.
 */
export class SigningSequenceError extends Data.TaggedError('SigningSequenceError')<{
  readonly completed: readonly SigningSuccess[]
  readonly failedIndex: number
  readonly failure: SigningError
}> {}
