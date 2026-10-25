/**
 * CIP-8 / CIP-30 `signData` — the keyed half.
 *
 * Only the two operations a wallet performs with a key in hand live here. The two that do not —
 * `verifyDataForAddress` and `assembleData` — are in `@evolution-sdk/review/Cose`.
 *
 * ⚠️ {@link verifyData} is CIP-8 P2 always and P1 only when the protected header happens to claim
 * an address, which means a claimless message verifies here while proving control of nothing.
 * Anything that grants access wants `review`'s `Cose.verifyDataForAddress` instead.
 *
 * @since 0.1.0
 */

import {Bip32PrivateKey, Bytes} from '@evolution-sdk/evolution'
import {SignData} from '@evolution-sdk/evolution/cose'
import type {AddressHex, KeyHashHex, XprvHex} from '@evolution-sdk/review/Brands'
import type {DataSignature} from '@evolution-sdk/review/Cose'
import {op} from './Op.js'

/**
 * What the protected `address` claim may carry: a full address, or — for a hardware wallet's
 * KEY_HASH envelope — only the 28-byte credential the signing key hashes to.
 */
export type CoseAddressHeader = AddressHex | KeyHashHex

export type {DataSignature}

/**
 * Sign `payloadHex` as `addressHex`, returning the CIP-30 pair.
 *
 * `addressHex` becomes the protected `address` claim. `includeKid` adds the key id a CIP-30 wallet
 * normally emits; a hardware envelope omits it, which is why it is a parameter and not a constant.
 *
 * @since 0.1.0
 * @category signing
 */
export const signData = (xprvHex: XprvHex, addressHex: CoseAddressHeader, payloadHex: string, includeKid = true) =>
  op('coseSignData', (): DataSignature => {
    const signed = SignData.signData(
      addressHex,
      Bytes.fromHex(payloadHex),
      Bip32PrivateKey.toPrivateKey(Bip32PrivateKey.fromHex(xprvHex)),
      {includeKeyId: includeKid},
    )
    return {signature: Bytes.toHex(signed.signature), key: Bytes.toHex(signed.key)}
  })

/**
 * Verify the signature, and the address claim when the message carries one.
 *
 * ⚠️ Not an authentication primitive — see this module's note.
 *
 * @since 0.1.0
 * @category verification
 */
export const verifyData = (sig: DataSignature) =>
  op('coseVerifyData', () =>
    SignData.verifyMessage({signature: Bytes.fromHex(sig.signature), key: Bytes.fromHex(sig.key)}),
  )
