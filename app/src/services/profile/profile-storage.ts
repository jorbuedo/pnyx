/**
 * Profile-scoped `@pnyx/storage` handle.
 *
 * The app reaches persistent storage two ways: `platform/storage.ts` (the
 * `storage` object, ~40 modules) and `@pnyx/storage`'s `createPlatformStorage`
 * (the Effect-shaped one, used by the multisig / contacts / dApp / cosign
 * stores). Both have to be partitioned or the decoy inherits half the real
 * profile's state, so this is the second one's entry point.
 *
 * Call this instead of `createPlatformStorage()` anywhere in the app. The
 * default profile's prefix is empty, so the bytes are unchanged for installs
 * that predate profiles.
 *
 * @module
 */

import {createPlatformStorage, createPrefixedStorage, type Storage} from '@pnyx/storage'
import {activeKeyPrefix} from './active-profile'

/** A storage handle namespaced to the profile this process opened. */
export const createProfileStorage = (): Storage => createPrefixedStorage(createPlatformStorage(), activeKeyPrefix())
