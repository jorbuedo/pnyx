/**
 * From a scanned CIP-8 message request to a signing decision.
 *
 * The transaction counterpart is `sign-request-review.ts`, and this exists for the same reason: one
 * place composes classification with the ownership check, so no screen can reach a signing ceremony
 * having done only half of it.
 *
 * **The rule this module exists to enforce.** A `cardano-sign-cip8-data-request` carries the
 * derivation path and account xpub the *sender* believes should sign. Obeying that would let an
 * unauthenticated counterparty choose which of our keys signs its message. So the path is
 * display-only and the signing key is resolved the way the dApp `signData` rail already resolves it
 * — from the address, against our own credentials. This mirrors the rule item 29 already applies to
 * transactions, where `precomputedSigningPaths` is deliberately left off.
 *
 * @module
 */

import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {
  type CardanoSignCip8DataRequest,
  decodeCardanoSignCip8DataRequest,
  formatKeyPath,
  UR_TYPE_SIGN_CIP8_DATA_REQUEST,
  UR_TYPE_SIGN_DATA_REQUEST,
  type Ur,
} from '@pnyx/ur'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {networkOfAddress} from './sign-request-review'

/** The wallet facts an ownership decision needs. All public, all ours. */
export type Cip8Signer = {
  readonly paymentKeyHashHex: string
  /** Absent on a bare-address watch-only import, which therefore cannot answer a stake-key request. */
  readonly stakeKeyHashHex: string | null
  readonly paymentPath: string
  readonly stakePath: string
  /** Account xpub (pubkey‖chaincode, hex). `null` when it has not been backfilled yet. */
  readonly accountXpubHex: string | null
}

type SignableCommon = {
  readonly kind: 'signable'
  /**
   * Echoed back on the reply so the coordinator can match it to the request it sent. Carried
   * through untouched, including its absence, which means the requester did not ask to correlate.
   */
  readonly requestId?: Uint8Array
  /** The message bytes, exactly as scanned. What the screen renders is derived from these. */
  readonly messageHex: string
  /** Resolved against our own credentials — never taken from the request. */
  readonly signingPath: string
  readonly hashPayload: boolean
  /** What the request *claimed* should sign. Display-only, and worth showing when it differs. */
  readonly claimedPath: string
  /** ⚠️ Attacker-authored. Render labelled as unverified, or not at all. */
  readonly unverifiedOrigin?: string
}

/**
 * The two CIP-8 address modes are separate variants rather than one shape with optional fields.
 *
 * ⚠️ Not a stylistic choice. This directory has already shipped the bug where an absent address
 * became `addressHex: ''`, and `Address.inspect('')` returns a base address with *empty*
 * credentials rather than throwing — so every input classified as not-ours and nothing looked
 * broken. `KEY_HASH` mode genuinely has no address, so it must not have a field to leave empty.
 * See `verify-request-utxos.ts`, which uses `Omit` for the same reason.
 */
export type Cip8Decision =
  | (SignableCommon & {
      readonly mode: 'address'
      /** The address in wire form, for the COSE `Sig_structure`. */
      readonly addressHex: string
      readonly addressBech32: string
    })
  | (SignableCommon & {
      readonly mode: 'key-hash'
      /**
       * What goes in the COSE protected `address` header in this mode: the 28-byte hash of the
       * key that signs. Carried rather than left out, because the header is not optional — the
       * signature is over a `Sig_structure` containing it, so an absent one is not "no claim", it
       * is a different signature that will not verify.
       */
      readonly keyHashHex: string
    })
  | {readonly kind: 'refused'; readonly reason: Cip8RefusalReason; readonly detail: string}

export type Cip8RefusalReason =
  /** Tag 2205: a bare signature over arbitrary bytes, which is a transaction witness in disguise. */
  | 'raw-sign-data'
  /** A UR this decision does not handle. */
  | 'unsupported-type'
  /** The payload did not parse. */
  | 'malformed'
  /** The address, or the key the request names, is not this wallet's. */
  | 'not-ours'
  /** The address declares a different Cardano network than this wallet is on. */
  | 'wrong-network'
  /** `KEY_HASH` mode with no way to establish that the named key is ours. */
  | 'unverifiable-key'

const refuse = (reason: Cip8RefusalReason, detail: string): Cip8Decision => ({kind: 'refused', reason, detail})

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/**
 * `ADDRESS` mode: resolve the signing key from the address, ignoring the request's claim.
 *
 * Credentials rather than the address string, because one credential appears in several address
 * forms — base, enterprise, reward — and a request using a different form of *our* key is
 * legitimate. Comparing bech32 would reject it, and would also mean trusting the sender's spelling.
 */
const resolveFromAddress = (signer: Cip8Signer, addressHex: string): string | null => {
  try {
    const info = Address.inspect(addressHex)
    if (info.paymentCredHex === signer.paymentKeyHashHex) return signer.paymentPath
    if (signer.stakeKeyHashHex !== null && info.stakeCredHex === signer.stakeKeyHashHex) return signer.stakePath
    return null
  } catch (e: unknown) {
    // `null` is also "not one of our credentials", the branch above — the same refusal on the
    // path deciding what an air-gapped device may be asked to sign.
    logger.warn('Address could not be inspected for a Keystone signing path', {
      origin: 'keystone/cip8-request-review',
      error: String(e),
    })
    return null
  }
}

/**
 * `KEY_HASH` mode (CIP-95 DRep): there is no address, so the only checkable claim is the xpub.
 *
 * Accepting the request's path on the strength of a matching xpub is sound only because the path is
 * then required to be one of the two we would use anyway — so the key that signs is one this wallet
 * already signs with, not an arbitrary child the sender chose. Without a known account xpub there is
 * nothing to check against, and the request is refused rather than assumed.
 */
const resolveFromXpub = (
  signer: Cip8Signer,
  request: CardanoSignCip8DataRequest,
): Cip8Decision | {readonly signingPath: string; readonly keyHashHex: string} => {
  if (signer.accountXpubHex === null) {
    return refuse('unverifiable-key', 'no account xpub on record to check the request against')
  }
  if (toHex(request.xpub).toLowerCase() !== signer.accountXpubHex.toLowerCase()) {
    return refuse('not-ours', 'the request names an account key this wallet does not hold')
  }
  const claimed = formatKeyPath(request.derivationPath)
  // Restricting to the two paths we would use anyway is what makes accepting the request's path
  // sound: the key that signs is one this wallet already signs with, not a child the sender chose.
  if (claimed === signer.paymentPath) return {signingPath: claimed, keyHashHex: signer.paymentKeyHashHex}
  if (claimed === signer.stakePath) {
    return signer.stakeKeyHashHex === null
      ? refuse('not-ours', 'this wallet has no stake key')
      : {signingPath: claimed, keyHashHex: signer.stakeKeyHashHex}
  }
  return refuse('not-ours', `this wallet does not sign at ${claimed}`)
}

/**
 * Decide what to do with a scanned CIP-8 request.
 *
 * `ourNetworkId` is Cardano's (0 testnet / 1 mainnet). Required for the same reason the transaction
 * decision requires it: the request names no network, and a COSE signature made by a
 * testnet-configured wallet proves control of the same key on mainnet.
 */
export const decideCip8Request = (
  ur: Ur,
  signer: Cip8Signer,
  ourNetworkId: number,
): Effect.Effect<Cip8Decision, never> =>
  Effect.gen(function* () {
    if (ur.type === UR_TYPE_SIGN_DATA_REQUEST) {
      // Refused by name rather than as a generic unsupported type, the way 2212 is: the user is
      // owed the reason, and the reason is not "we have not got round to it".
      return refuse(
        'raw-sign-data',
        'cardano-sign-data-request asks for a bare signature over arbitrary bytes, which is a transaction witness in disguise',
      )
    }
    if (ur.type !== UR_TYPE_SIGN_CIP8_DATA_REQUEST) return refuse('unsupported-type', ur.type)

    const decoded = decodeCardanoSignCip8DataRequest(ur.cbor)
    if (!decoded.ok) return refuse('malformed', decoded.error)
    const request = decoded.value
    const claimedPath = formatKeyPath(request.derivationPath)
    const common = {
      ...(request.requestId === undefined ? {} : {requestId: request.requestId}),
      messageHex: toHex(request.signData),
      hashPayload: request.hashPayload,
      claimedPath,
      ...(request.origin === undefined ? {} : {unverifiedOrigin: request.origin}),
    }

    if (request.addressFieldType === 'KEY_HASH') {
      const resolved = resolveFromXpub(signer, request)
      if ('kind' in resolved) return resolved
      return {kind: 'signable', mode: 'key-hash', ...common, ...resolved}
    }

    // The decoder guarantees an address in ADDRESS mode, so this is a type narrowing, not a check.
    const addressBech32 = request.addressBech32
    if (addressBech32 === undefined) return refuse('malformed', 'ADDRESS mode with no address')

    const declared = networkOfAddress(addressBech32)
    if (declared !== undefined && declared !== ourNetworkId) {
      return refuse('wrong-network', `the address is on network ${declared}, this wallet is on ${ourNetworkId}`)
    }

    const addressHex = yield* Address.fromBech32(Bech32(addressBech32)).pipe(Effect.either)
    if (addressHex._tag === 'Left')
      return refuse('malformed', `address does not decode: ${addressBech32.slice(0, 16)}…`)

    const signingPath = resolveFromAddress(signer, addressHex.right)
    if (signingPath === null) return refuse('not-ours', 'the address is not owned by this wallet')

    return {kind: 'signable', mode: 'address', ...common, signingPath, addressHex: addressHex.right, addressBech32}
  })
