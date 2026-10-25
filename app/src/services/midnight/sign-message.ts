/**
 * Signing an arbitrary message with this wallet's Night key, for the dApp connector's `signData`.
 *
 * ⚠️ **This one needs key material, unlike every other connector method.** The reads are served from
 * storage and endpoints; signing is the only place a biometric prompt is correct — and it must only ever
 * run after the user has approved the request, which is why the handler refuses with a sentinel instead
 * of calling this itself.
 *
 * The key is role 0 (Night) — the one an unshielded address names, matching the API's
 * `keyType: 'unshielded'`, and the same key a transfer is signed with.
 *
 * @module
 */

import {Roles} from '@midnight-ntwrk/wallet-sdk-hd'
import {hex} from '@pnyx/crypto'
import {type NightSignature, walletSignData} from '@pnyx/midnight-native'
import {deriveMidnightRoleKey} from '@pnyx/wallet'
import {mnemonicToSeedSync} from '@scure/bip39'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {MidnightBuildError} from './build-failure'

const ORIGIN = 'midnight-sign-message'

/**
 * Sign `messageHex` with the wallet's Night key.
 *
 * Throws when the vault refuses, the key cannot be derived, or the native signer rejects the message —
 * each is logged with which step failed, because "the user declined" and "we could not derive the key"
 * lead a caller to say very different things.
 */
export const signMidnightMessage = async (params: {
  readonly groupId: string
  readonly accountIndex: number
  readonly messageHex: string
  readonly biometricPrompt: string
}): Promise<NightSignature> => {
  const decoded = hex.decode(params.messageHex)
  if (decoded._tag === 'Left') {
    // The handler decodes the dApp's payload, so a bad value here is our own bug rather than the page's.
    logger.error('a message to sign was not hex', {origin: ORIGIN, groupId: params.groupId})
    throw new MidnightBuildError({cause: 'malformed-input', reason: 'the message to sign is not hex'})
  }

  const {createEnclaveMnemonicVault} = await import('../credential-vault')
  const mnemonic = await Effect.runPromise(
    createEnclaveMnemonicVault().retrieve(params.groupId, params.biometricPrompt),
  )
  const seed = mnemonicToSeedSync(mnemonic)
  const nightRoleKey = await Effect.runPromise(
    deriveMidnightRoleKey(seed, Roles.NightExternal, {account: params.accountIndex}),
  )

  const signature = await walletSignData(nightRoleKey, decoded.right)
  // Logged on success too: a signature the user approved and never saw the effect of is worth a trace,
  // and the key is public.
  logger.info('signed a dApp message with the Night key', {
    origin: ORIGIN,
    groupId: params.groupId,
    bytes: decoded.right.length,
    verifyingKey: signature.verifyingKey,
  })
  return signature
}
