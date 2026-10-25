/**
 * Tests for the device push-registration call: stored-token reads, the
 * rotation-path override, that failures resolve false instead of throwing
 * (push registration must never break a sign-in), and that the binding carries
 * a signature the service will actually accept.
 *
 * The message builder and Ed25519 are the real ones — they are pure — so the
 * signature assertion here verifies the same bytes `verifyDeviceBinding`
 * reconstructs server-side, rather than a copy of the rule.
 */

import {ed25519} from '@noble/curves/ed25519.js'
import {authKeyPair, deviceBindingMessage, identitySkFromForumRoot} from '@pnyx/contract-client/identity'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {PnyxSession} from './pnyx-session'

const {registerDevice, storedTokenGet, loggerError, fetchAuthDomain, fetchAuthNonce, recordInfraSignature} = vi.hoisted(
  () => ({
    registerDevice: vi.fn(),
    storedTokenGet: vi.fn(),
    loggerError: vi.fn(),
    fetchAuthDomain: vi.fn(),
    fetchAuthNonce: vi.fn(),
    recordInfraSignature: vi.fn(),
  }),
)

vi.mock('../logger', () => ({
  logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: loggerError},
}))
vi.mock('./pnyx-api', () => ({pnyxApi: {registerDevice}}))
vi.mock('./notification-storage', () => ({notificationPrefs: {fcmToken: {get: storedTokenGet}}}))
vi.mock('./pnyx-session', () => ({fetchAuthDomain, fetchAuthNonce}))
vi.mock('./signing-audit', () => ({recordInfraSignature}))
// The derivation reaches the native module, which cannot run here. Stubbed rather than left to throw so
// the binding under test is the one a device actually sends — contract included.
vi.mock('./identity-contract', () => ({identityContractAddressFor: async () => new Uint8Array(32).fill(0xab)}))

import {registerDeviceWithService} from './device-registration'

const FORUM_ROOT = new Uint8Array(32).fill(9)
const NETWORK = 'preprod'
const IDENTITY = 'pnyx_id_preprod1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'

const session: PnyxSession = {
  token: 'session-jwt',
  network: NETWORK,
  receivedAtMs: 1_700_000_000_000,
  forumRoot: FORUM_ROOT,
  identity: IDENTITY,
}

beforeEach(() => {
  vi.clearAllMocks()
  registerDevice.mockResolvedValue({registered: true})
  fetchAuthDomain.mockResolvedValue('pnyx.test')
  fetchAuthNonce.mockResolvedValue('nonce-1')
})

describe('registerDeviceWithService', () => {
  it('registers the stored FCM token with the session JWT and the OS platform', async () => {
    storedTokenGet.mockResolvedValue('stored-fcm-token')

    await expect(registerDeviceWithService(session)).resolves.toBe(true)

    // Platform.OS is 'ios' in the repo's react-native test mock.
    expect(registerDevice).toHaveBeenCalledExactlyOnceWith('session-jwt', {
      fcmToken: 'stored-fcm-token',
      platform: 'ios',
      nonce: 'nonce-1',
      signature: expect.any(String),
      // Named, not looked up: one contract per identity, so the service has no address to read the
      // row at and checks the template of what this points to instead.
      contract: 'ab'.repeat(32),
    })
  })

  // The point of the whole change: a JWT is a bearer token, so the service must be able to check
  // that the identity claiming this token owns it. Verified against the public half the identity
  // publishes on-chain as `authPub`.
  it('signs the exact binding the service verifies', async () => {
    storedTokenGet.mockResolvedValue('stored-fcm-token')

    await registerDeviceWithService(session)

    const {signature} = registerDevice.mock.calls[0]?.[1] as {signature: string}
    const expected = deviceBindingMessage('pnyx.test', NETWORK, IDENTITY, 'nonce-1', 'stored-fcm-token', 'ios')
    const authPub = authKeyPair(identitySkFromForumRoot(FORUM_ROOT)).publicKey
    expect(ed25519.verify(Buffer.from(signature, 'hex'), expected, authPub)).toBe(true)
  })

  it('logs the signature to the infra audit trail', async () => {
    storedTokenGet.mockResolvedValue('stored-fcm-token')

    await registerDeviceWithService(session)

    expect(recordInfraSignature).toHaveBeenCalledExactlyOnceWith({
      purpose: 'device-push-binding',
      payloadHex: expect.any(String),
      signer: IDENTITY,
      signerKind: 'pnyx-id',
    })
  })

  it('prefers an explicitly passed token over the stored one (rotation path)', async () => {
    storedTokenGet.mockResolvedValue('stale-stored-token')

    await expect(registerDeviceWithService(session, 'rotated-token')).resolves.toBe(true)

    expect(storedTokenGet).not.toHaveBeenCalled()
    expect(registerDevice).toHaveBeenCalledExactlyOnceWith('session-jwt', {
      fcmToken: 'rotated-token',
      platform: 'ios',
      nonce: 'nonce-1',
      contract: 'ab'.repeat(32),
      signature: expect.any(String),
    })
  })

  it('resolves false without calling the service when no token exists', async () => {
    storedTokenGet.mockResolvedValue(null)

    await expect(registerDeviceWithService(session)).resolves.toBe(false)

    expect(registerDevice).not.toHaveBeenCalled()
    expect(loggerError).not.toHaveBeenCalled()
  })

  // A session with no `forumRoot` (the seedless / manual-card paths) cannot prove it owns the
  // identity, so it must not register at all rather than send an unprovable binding.
  it('skips registration when the session cannot sign', async () => {
    storedTokenGet.mockResolvedValue('stored-fcm-token')
    const {forumRoot: _omitted, ...seedless} = session

    await expect(registerDeviceWithService(seedless as PnyxSession)).resolves.toBe(false)

    expect(registerDevice).not.toHaveBeenCalled()
    expect(recordInfraSignature).not.toHaveBeenCalled()
  })

  // No domain means no way to know what to bind the signature to. Guessing one would produce a
  // signature that silently fails to verify.
  it.each([
    ['domain', () => fetchAuthDomain.mockResolvedValue(null)],
    ['nonce', () => fetchAuthNonce.mockResolvedValue(null)],
  ])('skips registration when the service supplies no %s', async (_what, arrange) => {
    storedTokenGet.mockResolvedValue('stored-fcm-token')
    arrange()

    await expect(registerDeviceWithService(session)).resolves.toBe(false)

    expect(registerDevice).not.toHaveBeenCalled()
  })

  it('resolves false and logs when the service call fails', async () => {
    storedTokenGet.mockResolvedValue('stored-fcm-token')
    registerDevice.mockRejectedValue(new Error('503'))

    await expect(registerDeviceWithService(session)).resolves.toBe(false)

    expect(loggerError).toHaveBeenCalledOnce()
  })

  it('resolves false and logs when the token read itself fails', async () => {
    storedTokenGet.mockRejectedValue(new Error('storage unavailable'))

    await expect(registerDeviceWithService(session)).resolves.toBe(false)

    expect(registerDevice).not.toHaveBeenCalled()
    expect(loggerError).toHaveBeenCalledOnce()
  })
})
