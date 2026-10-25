/**
 * Insecure dev vault — plaintext mnemonic storage for UI iteration.
 *
 * Opt-in via `EXPO_PUBLIC_INSECURE_DEV_VAULT=1`, and hard-gated on `__DEV__`
 * so release bundles compile the branch away. When enabled,
 * `createEnclaveMnemonicVault` returns this vault instead of the OS keychain:
 * seeds live in plain platform storage (localStorage on web, MMKV on native)
 * and no store/retrieve ever fires an OS auth prompt. This is what lets the
 * app run on surfaces without a keystore (the web dev target) and without
 * biometric/PIN friction (emulators). It is NOT a credential scheme — never
 * enable it for a wallet holding real funds.
 *
 * The device-lock capability probe also passes under this flag
 * (`keychain-capability.ts`), since there is no keychain entry to protect.
 *
 * @module
 */

import {asMnemonic, type Mnemonic} from '@pnyx/crypto'
import {Effect} from 'effect'
import {insecureDevVaultRequested} from '../../config/env'
// `deviceStorage`, NOT the profile-scoped `storage`: this stands in for the OS
// keychain, which is not partitioned by profile. Profiles are separated by slot
// id (`pnyx-identity` vs `pnyx-identity/<profile>`), exactly as the real vault
// does it. Using profile-scoped storage here made the dev vault behave
// differently from production — and silently broke the duress wipe, which
// deletes the real profile's seed *while the decoy is active* and so was writing
// its delete into the decoy's partition.
import {deviceStorage as storage} from '../../platform/storage'
import {VaultError} from './types'

const KEY_PREFIX = '@pnyx/dev-insecure-mnemonic/'

export const isInsecureDevVaultEnabled = (): boolean => __DEV__ && insecureDevVaultRequested()

const keyFor = (groupId: string): string => `${KEY_PREFIX}${groupId}`

const tryStorage = <A>(op: string, thunk: () => Promise<A>): Effect.Effect<A, VaultError> =>
  Effect.tryPromise({
    try: thunk,
    catch: (e) =>
      new VaultError({code: 'storage', message: `${op}: ${e instanceof Error ? e.message : String(e)}`, cause: e}),
  })

/**
 * Same surface as the enclave vault (`EnclaveMnemonicVault`), backed by plain
 * platform storage. Typed structurally to avoid a circular import with
 * `enclave-vault.ts`, which branches to this factory.
 */
export const createInsecureDevVault = () => ({
  store: (groupId: string, mnemonic: string, _authPrompt?: string): Effect.Effect<void, VaultError> =>
    tryStorage('store', () => storage.set(keyFor(groupId), mnemonic)),

  // Brands for the same reason the enclave vault does (Phase 16 item 43): this is a vault decrypt
  // point, so it is a place the `Mnemonic` brand may be minted. It must satisfy the same contract or
  // the dev build would type-check differently from the real one.
  retrieve: (groupId: string, _authPrompt?: string): Effect.Effect<Mnemonic, VaultError> =>
    tryStorage('retrieve', () => storage.get(keyFor(groupId))).pipe(
      Effect.flatMap((value) =>
        value === null
          ? Effect.fail(new VaultError({code: 'not-found', message: `No dev-vault entry for groupId: ${groupId}`}))
          : Effect.succeed(asMnemonic(value)),
      ),
    ),

  has: (groupId: string): Effect.Effect<boolean, VaultError> =>
    tryStorage('has', () => storage.get(keyFor(groupId))).pipe(Effect.map((value) => value !== null)),

  delete: (groupId: string): Effect.Effect<void, VaultError> =>
    tryStorage('delete', () => storage.remove(keyFor(groupId))),

  enumerate: (): Effect.Effect<readonly string[], VaultError> =>
    tryStorage('enumerate', () => storage.getAllKeys()).pipe(
      Effect.map((keys) => keys.filter((k) => k.startsWith(KEY_PREFIX)).map((k) => k.slice(KEY_PREFIX.length))),
    ),
})
