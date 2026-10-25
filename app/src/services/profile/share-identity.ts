/**
 * Reuse the real profile's identity inside the decoy.
 *
 * A decoy with a *different* identity is a giveaway to anyone who already knows
 * who you are: the handle they expect is simply not there. Sharing the identity
 * removes that tell — the decoy is recognisably you, and only the wallets differ.
 *
 * **Only the seed is copied, and that is all it takes.** The handle lives in the
 * identity contract's `names` map bound to `C` (`services/handle-resolve.ts`), so
 * the same seed derives the same `C` and resolves the same handle with nothing
 * else moved. There is no local name to carry: an earlier
 * `pnyx:identity-name` label existed but was never written — the identity
 * onboarding run navigates to `preparing` without a name — and it has been
 * removed.
 *
 * The wallets stay separate for free: they come from the profile-scoped groups
 * blob, which the decoy does not share.
 *
 * **The trade this makes, stated plainly.** The decoy holds a copy of the
 * identity seed, so whoever you hand the decoy to can act as you in the forum —
 * not merely be seen as you. That is inherent to the choice, and it also means a
 * duress wipe, which deletes the *real* profile's identity slot, leaves the copy
 * in the decoy intact. Deliberate: an identity that vanished mid-coercion would
 * be its own tell, and the user's recovery phrase still restores everything.
 *
 * @module
 */

import {Effect} from 'effect'
import {createEnclaveMnemonicVault} from '../credential-vault'
import {identityVaultIdFor} from '../identity-wallet'
import {DEFAULT_PROFILE_ID} from './profile-id'

/**
 * Read the real profile's identity seed.
 *
 * Fires the OS biometric prompt — the seed comes out of the enclave. Callers run
 * this from inside the decoy; the keychain is not partitioned by profile, so the
 * real slot is reachable by id.
 */
export const readSharedIdentityMnemonic = async (authPrompt?: string): Promise<string> =>
  Effect.runPromise(createEnclaveMnemonicVault().retrieve(identityVaultIdFor(DEFAULT_PROFILE_ID), authPrompt))
