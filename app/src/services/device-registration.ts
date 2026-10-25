/**
 * Device push registration with the content service.
 *
 * `POST /devices` binds this device's FCM token to the signed-in identity so
 * the service can target pushes at it (services/content owns the FCM sender).
 * Registration needs the Pnyx session JWT, which never exists at FCM-init
 * time — the session flow calls this instead
 * (providers/use-device-registration.ts).
 *
 * The JWT alone is not enough to *claim* a token, and deliberately so: it is a
 * bearer credential, so whoever held one could bind their own device to this
 * identity and start receiving its notifications. The binding therefore carries
 * an Ed25519 signature from the identity's own auth key over a server-issued
 * nonce and this exact token — the same key and nonce store login uses, under a
 * distinct domain tag so neither signature can stand in for the other.
 */

import {ed25519} from '@noble/curves/ed25519.js'
import {
  authKeyPair,
  deviceBindingMessage,
  identityCommitmentOf,
  identitySkFromForumRoot,
} from '@pnyx/contract-client/identity'
import {Platform} from 'react-native'
import {logger} from '../logger'
import {notificationPrefs} from './notification-storage'
import {pnyxApi} from './pnyx-api'
import {fetchAuthDomain, fetchAuthNonce, type PnyxSession} from './pnyx-session'
import {recordInfraSignature} from './signing-audit'

const ORIGIN = 'device-registration'

const hex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * Register the device's FCM token with the content service.
 *
 * `fcmToken` overrides the stored one — the rotation path passes the fresh
 * token directly rather than racing the storage write. Resolves `false` when
 * there is no token to register (permission denied, web, FCM unavailable), when
 * the session cannot sign (no `forumRoot`, e.g. the manual-card path), or when
 * the call fails; push registration never blocks a session.
 */
export const registerDeviceWithService = async (session: PnyxSession, fcmToken?: string): Promise<boolean> => {
  try {
    const token = fcmToken ?? (await notificationPrefs.fcmToken.get())
    if (token === null || token === undefined) return false
    // Re-derived from the session's cached master rather than the seed, so a rotated token can be
    // re-bound in the background without an enclave round trip. Absent on the seedless paths, where
    // there is no way to prove ownership — and a push nobody can prove they own is not one we send.
    if (session.forumRoot === undefined) {
      logger.debug('skipping push registration: session cannot sign a device binding', {origin: ORIGIN})
      return false
    }
    const [domain, nonce] = await Promise.all([fetchAuthDomain(), fetchAuthNonce()])
    if (domain === null || nonce === null) {
      logger.debug('skipping push registration: no domain/nonce from the service', {origin: ORIGIN})
      return false
    }

    const platform = Platform.OS
    const identitySk = identitySkFromForumRoot(session.forumRoot)
    const auth = authKeyPair(identitySk)
    // Copied before the wipe: `C` is derived from the same secret, and zeroing it first would leave
    // the derivation below reading a buffer of zeros — a different identity, silently.
    const identitySkForContract = Uint8Array.from(identitySk)
    identitySk.fill(0)
    const message = deviceBindingMessage(domain, session.network, session.identity, nonce, token, platform)
    const signature = ed25519.sign(message, auth.secretKey)
    auth.secretKey.fill(0)
    void recordInfraSignature({
      purpose: 'device-push-binding',
      payloadHex: hex(message),
      signer: session.identity,
      signerKind: 'pnyx-id',
    })

    // The contract this identity's row lives in. Named for the same reason login names it: one
    // contract per identity, so the service has no address to look the row up at — it checks the
    // template of whatever is there instead.
    const {identityContractAddressFor} = await import('./identity-contract')
    const contract = await identityContractAddressFor(identityCommitmentOf(identitySkForContract))
      .then((address) => hex(address))
      .catch((error: unknown) => {
        logger.warn('device binding could not derive the identity contract address', {
          origin: ORIGIN,
          error: String(error),
        })
        return undefined
      })

    await pnyxApi.registerDevice(session.token, {
      fcmToken: token,
      platform,
      nonce,
      signature: hex(signature),
      ...(contract === undefined ? {} : {contract}),
    })
    logger.debug('Device registered for push with the content service', {origin: ORIGIN})
    return true
  } catch (error) {
    logger.error('Failed to register device for push with the content service', {
      origin: ORIGIN,
      cause: error,
    })
    return false
  }
}
