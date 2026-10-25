/**
 * Turning a transaction this wallet built into the request a Keystone will answer.
 *
 * **Thin on purpose.** Everything hard already exists and is shared with the software and
 * Ledger/Trezor paths, so this module gathers nothing itself:
 *
 * | what | who already does it |
 * |---|---|
 * | which of our keys must sign, and every required key hash | `resolveCardanoSigningPaths` (`@pnyx/tx-review`) — inputs, `required_signers`, certificates, withdrawals, collateral |
 * | body or hash | `./sign-request-shape.ts` |
 * | address → derivation path | `services/cardano/address-paths.ts` |
 * | checking what came back | `verifyWitnessSignatures` (`@pnyx/signing-service`) |
 * | the wire format | `@pnyx/ur` |
 *
 * ⚠️ **The one place this must be stricter than the reference implementation.** Gero's builder pushes
 * the wallet's stake key into `extraSigners` for *every* `requiredExtraSignatures` entry, with its own
 * comment saying the hash ought to be compared first and then not comparing it. That tells a device we
 * can sign for a credential we may not hold: at best the device refuses, at worst it returns a witness
 * from the wrong key and the transaction fails after a quorum has already signed. Here a required hash
 * becomes an `extraSigner` **only** when it resolves to a key we hold.
 *
 * @module
 */

import {
  type CardanoSignRequest,
  type CardanoSignTxHashRequest,
  type CardanoUtxo,
  type CryptoKeypath,
  encodeCardanoSignRequest,
  encodeCardanoSignTxHashRequest,
} from '@pnyx/ur'

import type {SignRequestShape} from './sign-request-shape'

/** 2^31 — the bit a hardened index carries in the flat array form the hardware package uses. */
const HARDENED = 0x80000000

/** A key hash reaches us as hex and goes out as bytes. */
const hexToBytes = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error(`not a hex key hash: ${hex}`)
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * `m/1852'/1815'/0'/0/0` → the index/hardened pairs the UR format wants.
 *
 * Deliberately not a second path parser: it splits what `parseDerivationPath` folds together, so the
 * two cannot disagree about what `'` means. Kept local because the UR shape is this module's concern.
 */
export const keypathFromString = (path: string, sourceFingerprint?: number): CryptoKeypath => {
  const components = path
    .replace(/^m\//, '')
    .split('/')
    .filter((part) => part.length > 0)
    .map((part) => {
      const hardened = part.endsWith("'") || part.endsWith('h')
      const index = Number.parseInt(hardened ? part.slice(0, -1) : part, 10)
      if (!Number.isSafeInteger(index) || index < 0 || index >= HARDENED) {
        throw new Error(`not a derivation path component: ${part}`)
      }
      return {index, hardened}
    })
  if (components.length === 0) throw new Error(`not a derivation path: ${path}`)
  return {components, ...(sourceFingerprint === undefined ? {} : {sourceFingerprint})}
}

/** One of our inputs, already resolved against our own UTxO set rather than asserted by anyone. */
export type OwnedInput = {
  readonly transactionHash: Uint8Array
  readonly index: number
  /** Lovelace as a decimal string — it exceeds 2^53 in principle. */
  readonly amount: string
  /** Bech32. The device shows it, so it must be the address we resolved, never a reconstruction. */
  readonly address: string
  /** The path that signs for this input. */
  readonly path: string
}

export type KeystoneRequestParams = {
  /**
   * The full transaction CBOR — what 2202 carries as `signData`.
   *
   * ⚠️ The *transaction*, not the body: firmware parses a transaction and shows its outputs.
   */
  readonly transactionCbor: Uint8Array
  /** Body hash, hex, for the 2212 shape. */
  readonly txHashHex: string
  /** From `./sign-request-shape.ts` — never decided here. */
  readonly shape: SignRequestShape
  /** From `resolveCardanoSigningPaths().signingPaths`: deduped, registry order. */
  readonly signingPaths: readonly string[]
  /** From `resolveCardanoSigningPaths().requiredKeyHashes` — includes hashes we do not hold. */
  readonly requiredKeyHashes: readonly string[]
  /** Key hash (hex) → the path that holds it. The resolution Gero's builder skips. */
  readonly ownedKeyHashes: ReadonlyMap<string, string>
  /** Path → bech32 address, for what the device displays. `services/cardano/address-paths.ts`. */
  readonly addressForPath: ReadonlyMap<string, string>
  readonly inputs: readonly OwnedInput[]
  readonly masterFingerprint: number
  readonly requestId?: Uint8Array
  /** Our own name. A *reader* must treat a counterparty's as attacker-authored. */
  readonly origin?: string
}

export type KeystoneSignPlan = {
  /** UR payload bytes, ready for the animated encoder. */
  readonly cbor: Uint8Array
  /** Which UR type the bytes are, so the presenter and the reply matcher agree. */
  readonly urType: 'cardano-sign-request' | 'cardano-sign-tx-hash-request'
  /**
   * Present when the device will show a hash rather than the transaction.
   *
   * ⚠️ **A screen that drops this has turned hash-signing into blind signing.** It is the sentence
   * that tells the user the device shows them less than the phone just did.
   */
  readonly hashOnlyBecause?: string
}

/** Every required hash that resolves to a key we hold, as `cardano-cert-key` entries. */
const extraSignersFor = (params: KeystoneRequestParams) =>
  params.requiredKeyHashes.flatMap((keyHash) => {
    const path = params.ownedKeyHashes.get(keyHash.toLowerCase())
    // ⚠️ Silence here is correct and load-bearing: a required hash we cannot resolve belongs to a
    // co-signer, and claiming it would tell the device to sign with a key we do not have.
    if (path === undefined) return []
    // ⚠️ Bytes on the wire, not the hex we resolve by. A 28-byte key hash sent as its 56-character
    // text would be a different value entirely, and the device would refuse or match the wrong key.
    return [{keyHash: hexToBytes(keyHash), keyPath: keypathFromString(path, params.masterFingerprint)}]
  })

/**
 * Build the request bytes for whichever shape this transaction forces.
 *
 * Refuses rather than degrades: an input with no path, a signing path with no address, or a hash shape
 * with nothing to sign are all cases where the alternative is a QR that a device either rejects or —
 * worse — answers with a witness from a key nobody chose.
 */
export const buildKeystoneSignRequest = (params: KeystoneRequestParams): KeystoneSignPlan => {
  if (params.shape.kind === 'hash') {
    const paths = params.signingPaths.map((path) => keypathFromString(path, params.masterFingerprint))
    const addressList = params.signingPaths.map((path) => {
      const address = params.addressForPath.get(path)
      // The device pairs paths and addresses positionally, so a gap would label one key with another's
      // address. Refusing beats sending a request whose display is wrong.
      if (address === undefined) throw new Error(`no address resolved for signing path ${path}`)
      return address
    })
    const request: CardanoSignTxHashRequest = {
      txHash: params.txHashHex,
      paths,
      addressList,
      ...(params.requestId === undefined ? {} : {requestId: params.requestId}),
      ...(params.origin === undefined ? {} : {origin: params.origin}),
    }
    return {
      cbor: encodeCardanoSignTxHashRequest(request),
      urType: 'cardano-sign-tx-hash-request',
      hashOnlyBecause: params.shape.reason,
    }
  }

  const utxos: readonly CardanoUtxo[] = params.inputs.map((input) => ({
    transactionHash: input.transactionHash,
    index: input.index,
    amount: input.amount,
    address: input.address,
    keyPath: keypathFromString(input.path, params.masterFingerprint),
  }))
  const request: CardanoSignRequest = {
    signData: params.transactionCbor,
    utxos,
    extraSigners: extraSignersFor(params),
    ...(params.requestId === undefined ? {} : {requestId: params.requestId}),
    ...(params.origin === undefined ? {} : {origin: params.origin}),
  }
  return {cbor: encodeCardanoSignRequest(request), urType: 'cardano-sign-request'}
}
