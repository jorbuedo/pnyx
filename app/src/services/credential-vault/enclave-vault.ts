/**
 * Enclave vault — the only credential scheme.
 *
 * Stores seed material (the wallet mnemonic) directly in the OS
 * keychain via `react-native-keychain` with
 * `BIOMETRY_ANY_OR_DEVICE_PASSCODE` so the user authenticates via biometric
 * or device passcode at retrieve time. No app-layer key derivation; the
 * platform's hardware-backed keystore is the root of trust.
 *
 * The service field of each entry is namespaced per wallet group
 * (`@pnyx/mnemonic/<groupId>`) so we can `getAllGenericPasswordServices`
 * to enumerate without ever triggering a biometric prompt.
 *
 * @module
 */

import {asMnemonic, type Mnemonic} from '@pnyx/crypto'
import {Effect} from 'effect'
import {Platform} from 'react-native'
import * as Keychain from 'react-native-keychain'
import {logger} from '../../logger'
import {getCachedMaterial, isCeremonyActive, setCachedMaterial} from './ceremony-cache'
import {classifyKeychainError} from './classify-keychain-error'
import {createInsecureDevVault, isInsecureDevVaultEnabled} from './insecure-dev-vault'
import {VaultError} from './types'

const SERVICE_PREFIX = '@pnyx/mnemonic/'

const serviceFor = (groupId: string): string => `${SERVICE_PREFIX}${groupId}`

/** Strip the prefix from a service name; returns null if the service isn't ours. */
export const groupIdFromService = (service: string): string | null =>
  service.startsWith(SERVICE_PREFIX) ? service.slice(SERVICE_PREFIX.length) : null

/**
 * Async post-mortem probes fired on a `key-invalidated` classification.
 *
 * When a user lands in the unrecoverable-key state we only have
 * the failing op's native code + message. To learn *what changed about
 * the device* we also need to ask the OS what its keystore can still do
 * RIGHT NOW. The breadcrumb emitted here won't always land on the
 * triggering Sentry event (it runs after `translate` returns), but the
 * user typically hits the failure repeatedly — subsequent events carry
 * the diagnostic in their breadcrumb trail, which is enough to triage.
 *
 * Best-effort: every probe individually swallows its own error so one
 * failing probe doesn't suppress the others, and the whole helper
 * `void`s the promise so callers don't have to.
 */
const runKeyInvalidatedDiagnostics = (op: string, service: string): void => {
  void (async () => {
    // `null` from a probe means "did not answer", which a legitimate null result also looks
    // like — so the reason is logged here rather than left to the aggregate line below.
    const probe = <A>(name: string, p: Promise<A>): Promise<A | null> =>
      p.catch((e) => {
        logger.debug('[enclave-vault] diagnostic probe failed', {
          origin: 'enclave-vault',
          probe: name,
          error: String(e),
        })
        return null
      })
    const [entryExists, securityLevel, biometryType] = await Promise.all([
      probe('hasGenericPassword', Keychain.hasGenericPassword({service})),
      probe('getSecurityLevel', Keychain.getSecurityLevel()),
      probe('getSupportedBiometryType', Keychain.getSupportedBiometryType()),
    ])
    logger.warn('[enclave-vault] key-invalidated diagnostics', {
      origin: 'enclave-vault',
      op,
      // `true` confirms the entry still exists at the storage layer — the
      // failure is a key-level problem, not a deleted-row problem.
      entryExists,
      // What the OS thinks its current keystore can do. A drop from
      // `SECURE_HARDWARE` (what we requested at store time) to
      // `SECURE_SOFTWARE` is a hard signal that the TEE state changed.
      securityLevel,
      // `null` means no biometric is enrolled — would invalidate every
      // biometric-bound key on the device.
      biometryType,
    })
  })()
}

/**
 * Translate a native keychain failure into a typed {@link VaultError}.
 *
 * Classification is delegated to {@link classifyKeychainError}, which keys
 * on the structured native `error.code` rather than message text. The
 * showed that regex-on-message produced false-positive `auth-cancelled`
 * results for TEE / data-integrity failures (AES-GCM tag mismatch, key
 * permanently invalidated) — those messages contain "authentication" and
 * "failed" but represent non-recoverable states. The new `key-invalidated`
 * code is what surfaces those paths to the UI as a re-import prompt.
 *
 * Non-cancel classifications are logged so Sentry sees the native code +
 * message — this is the only telemetry we have for tracking new keystore
 * failure shapes across devices. When the classification is
 * `key-invalidated`, additional async probes are kicked off via
 * {@link runKeyInvalidatedDiagnostics}.
 */
const translate = (e: unknown, op: string, service?: string): VaultError => {
  const classification = classifyKeychainError(e)
  if (classification === 'auth-cancelled') {
    return new VaultError({code: 'auth-cancelled', message: `${op}: user cancelled`, cause: e})
  }

  // Mirror the classifier's coercion of finite numeric error codes so
  // the breadcrumb captures every shape the classifier acts on. Logging
  // `nativeCode: null` for numeric codes would weaken the only
  // production telemetry signal we have for keystore failures.
  const rawCode = e != null && typeof e === 'object' ? ((e as {code?: unknown}).code ?? null) : null
  const nativeCode =
    typeof rawCode === 'string'
      ? rawCode
      : typeof rawCode === 'number' && Number.isFinite(rawCode)
        ? String(rawCode)
        : null
  const nativeMsg = e instanceof Error ? e.message : String(e)
  logger.warn('[enclave-vault] keychain failure', {
    origin: 'enclave-vault',
    op,
    classification,
    nativeCode,
    nativeMessage: nativeMsg,
  })

  if (classification === 'key-invalidated') {
    if (service !== undefined) runKeyInvalidatedDiagnostics(op, service)
    return new VaultError({
      code: 'key-invalidated',
      message: `${op}: keystore key no longer accessible on this device`,
      cause: e,
    })
  }
  return new VaultError({code: 'storage', message: `${op}: ${nativeMsg}`, cause: e})
}

/**
 * Production keychain options for the enclave path.
 *
 * - `BIOMETRY_ANY_OR_DEVICE_PASSCODE`: survives biometric re-enrollment,
 *   falls back to device passcode when biometric fails. Decision from
 *   the enclave-storage rework plan.
 * - `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (iOS): do not migrate to a new device.
 *   Incompatible with iCloud sync — see note below.
 * - `AES_GCM` storage (Android only): AndroidKeystore AES-GCM with
 *   authentication required (the biometric/passcode gate).
 * - `SECURE_HARDWARE` security level (Android only): requires the key to
 *   live in TEE-or-better hardware. Software-only Android keystore devices
 *   fail the capability gate before reaching this code.
 *
 * The `cloudSync` key MUST be omitted entirely (not `false`). On iOS the
 * native module's `cloudSyncValue()` truthiness-checks the dict lookup,
 * not the boolean value, so `cloudSync: false` is interpreted as
 * `kSecAttrSynchronizable: true`. Synchronizable items cannot use
 * `…ThisDeviceOnly` accessibility classes or `kSecAttrAccessControl`, so
 * `SecItemAdd` rejects the write with `errSecParam` (-50) → "One or more
 * parameters passed to a function were not valid". Omitting the
 * key leaves `kSecAttrSynchronizable` unset, which is the desired
 * non-syncing default.
 */
const isAndroid = Platform.OS === 'android'

/**
 * Resolve the security level to REQUEST from the Android keystore, once per
 * process. The capability gate (keychain-capability.ts) deliberately admits
 * software-keystore devices (`SecurityLevel >= SECRET` — emulators, rare
 * TEE-less hardware), so unconditionally demanding `SECURE_HARDWARE` here
 * makes the first store fail with `CryptoFailedException` on those devices.
 * Request the strongest level the device reports instead; the downgrade is
 * logged so Sentry can quantify the software-keystore population.
 */
let androidSecurityLevel: Promise<Keychain.SECURITY_LEVEL> | null = null
const resolveAndroidSecurityLevel = (): Promise<Keychain.SECURITY_LEVEL> => {
  androidSecurityLevel ??= Keychain.getSecurityLevel({
    accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
  }).then((level) => {
    if (level === Keychain.SECURITY_LEVEL.SECURE_HARDWARE) {
      return Keychain.SECURITY_LEVEL.SECURE_HARDWARE
    }
    logger.warn('[enclave-vault] device keystore is not hardware-backed — requesting software level', {
      origin: 'EnclaveVault',
      reportedLevel: level,
    })
    return Keychain.SECURITY_LEVEL.SECURE_SOFTWARE
  })
  return androidSecurityLevel
}

const writeOptions = (
  authPrompt: string | undefined,
  securityLevel?: Keychain.SECURITY_LEVEL,
): Keychain.SetOptions => ({
  service: '', // overridden per-call
  accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
  accessible: Keychain.ACCESSIBLE.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  ...(isAndroid && {
    storage: Keychain.STORAGE_TYPE.AES_GCM,
    securityLevel: securityLevel ?? Keychain.SECURITY_LEVEL.SECURE_HARDWARE,
  }),
  ...(authPrompt !== undefined && {authenticationPrompt: {title: authPrompt}}),
})

const readOptions = (authPrompt?: string): Keychain.GetOptions => ({
  service: '', // overridden per-call
  accessControl: Keychain.ACCESS_CONTROL.BIOMETRY_ANY_OR_DEVICE_PASSCODE,
  ...(authPrompt !== undefined && {authenticationPrompt: {title: authPrompt}}),
})

export type EnclaveMnemonicVault = {
  /** `authPrompt` is the optional UI string for the OS biometric / passcode prompt. */
  readonly store: (groupId: string, mnemonic: string, authPrompt?: string) => Effect.Effect<void, VaultError>
  /**
   * The single point where a plaintext mnemonic enters the process, and therefore the only place
   * that mints the {@link Mnemonic} brand (Phase 16 item 43). Everything downstream inherits it, so
   * a holder of seed material is visible to a type check rather than to a reviewer's memory.
   *
   * `store` is deliberately **not** branded: it accepts a phrase the user just typed or the app just
   * generated, which has not been through the vault and has no brand to claim.
   */
  readonly retrieve: (groupId: string, authPrompt?: string) => Effect.Effect<Mnemonic, VaultError>
  readonly has: (groupId: string) => Effect.Effect<boolean, VaultError>
  readonly delete: (groupId: string) => Effect.Effect<void, VaultError>
  /** Enumerate every wallet group with a stored mnemonic in the enclave. No auth prompt. */
  readonly enumerate: () => Effect.Effect<readonly string[], VaultError>
}

const writeAt =
  (service: string) =>
  (authPrompt: string | undefined, securityLevel?: Keychain.SECURITY_LEVEL): Keychain.SetOptions => ({
    ...writeOptions(authPrompt, securityLevel),
    service,
  })

const readAt =
  (service: string) =>
  (authPrompt: string | undefined): Keychain.GetOptions => ({
    ...readOptions(authPrompt),
    service,
  })

export const createEnclaveMnemonicVault = (): EnclaveMnemonicVault =>
  isInsecureDevVaultEnabled() ? createInsecureDevVault() : createKeychainVault()

const createKeychainVault = (): EnclaveMnemonicVault => ({
  store: (groupId, mnemonic, authPrompt) =>
    Effect.gen(function* () {
      const service = serviceFor(groupId)
      const securityLevel = isAndroid
        ? yield* Effect.tryPromise({
            try: () => resolveAndroidSecurityLevel(),
            catch: (e) => translate(e, 'store', service),
          })
        : undefined
      const result = yield* Effect.tryPromise({
        try: () => Keychain.setGenericPassword(groupId, mnemonic, writeAt(service)(authPrompt, securityLevel)),
        catch: (e) => translate(e, 'store', service),
      })
      // react-native-keychain returns `false` on certain
      // silent-failure paths (e.g. the OS refuses to persist the key
      // for any reason). Without this check the Effect resolved as
      // `void` and the caller thought the mnemonic was stored. Logging
      // the returned `storage` lets Sentry tell us whether the OS
      // honoured our `AES_GCM` + `SECURE_HARDWARE` request or quietly
      // downgraded — the only post-hoc signal that a key was created
      // in a degenerate state.
      if (result === false) {
        return yield* Effect.fail(
          new VaultError({
            code: 'storage',
            message: `store: keychain rejected the write for service ${service}`,
          }),
        )
      }
      logger.debug('[enclave-vault] store ok', {
        origin: 'enclave-vault',
        op: 'store',
        service,
        storage: result.storage,
      })
    }),

  retrieve: (groupId, authPrompt) =>
    Effect.gen(function* () {
      // Ceremony fast-path. When a ceremony is open for this group AND we
      // have a cached value (set by an earlier retrieve in the same
      // ceremony), short-circuit the keychain round-trip and skip the
      // biometric prompt. Keyed on `'mnemonic'` so an xpriv stored under
      // the same groupId never aliases. See `ceremony-cache.ts` for the
      // security stance.
      const cached = getCachedMaterial(groupId, 'mnemonic')
      if (cached !== null) return asMnemonic(cached)

      const service = serviceFor(groupId)
      const result = yield* Effect.tryPromise({
        try: () => Keychain.getGenericPassword(readAt(service)(authPrompt)),
        catch: (e) => translate(e, 'retrieve', service),
      })
      if (result === false) {
        return yield* Effect.fail(
          new VaultError({code: 'not-found', message: `No enclave entry for groupId: ${groupId}`}),
        )
      }
      if (isCeremonyActive(groupId)) setCachedMaterial(groupId, 'mnemonic', result.password)
      return asMnemonic(result.password)
    }),

  has: (groupId) =>
    Effect.tryPromise({
      try: () => Keychain.hasGenericPassword({service: serviceFor(groupId)}),
      catch: (e) => translate(e, 'has'),
    }),

  delete: (groupId) =>
    Effect.tryPromise({
      try: () => Keychain.resetGenericPassword({service: serviceFor(groupId)}),
      catch: (e) => translate(e, 'delete'),
    }).pipe(Effect.asVoid),

  enumerate: () =>
    Effect.tryPromise({
      try: () => Keychain.getAllGenericPasswordServices(),
      catch: (e) => translate(e, 'enumerate'),
    }).pipe(Effect.map((services) => services.map(groupIdFromService).filter((id): id is string => id !== null))),
})
