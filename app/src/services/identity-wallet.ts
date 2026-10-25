/**
 * The Pnyx identity wallet — the app's Midnight auth identity.
 *
 * A dedicated, software-only BIP-39 seed that powers SIWM (the content-service
 * session), the forum personas, and the Midnight identity
 * address. It is deliberately NOT a `WalletGroup`: it never appears in the
 * Wallets tab, has no chain accounts, cannot be hardware-backed, and is not
 * part of the wallet switcher. Funds wallets (Cardano full treatment,
 * BTC/EVM/SOL receive-only) are imported separately as wallet groups.
 *
 * Storage is the same enclave vault as wallet groups (OS keychain,
 * biometric/passcode-gated) under the reserved slot id {@link IDENTITY_VAULT_ID};
 * cloud recovery is the passkey-PRF blob (services/passkey-recovery.ts), which
 * wraps THIS seed.
 *
 * There is deliberately **no migration path from a wallet group's seed**. One
 * existed for installs predating the identity/wallet split; no such install
 * exists, so it was removed rather than carried as untestable code. Onboarding
 * creates this slot unconditionally, so "a wallet group but no identity" is not a
 * reachable state.
 *
 * @module
 */

import type {Mnemonic} from '@pnyx/crypto'
import {generateMnemonic} from '@scure/bip39'
import {wordlist} from '@scure/bip39/wordlists/english.js'
import {Effect} from 'effect'
import {createEnclaveMnemonicVault} from './credential-vault'
import {clearIdentityCardanoCreds, persistIdentityCardanoCreds} from './identity-cardano-creds'
import {getActiveProfile} from './profile/active-profile'
import {DEFAULT_PROFILE_ID, type ProfileId} from './profile/profile-id'

/**
 * Reserved enclave-vault slot for the identity seed. Wallet-group ids are
 * UUIDs (generateGroupId), so this constant can never collide with a group.
 */
export const IDENTITY_VAULT_ID = 'pnyx-identity'

/**
 * The identity slot for a profile.
 *
 * The default profile keeps the bare historical id, so an install that predates
 * profiles finds its seed exactly where it left it. Any other profile gets its
 * own slot — a decoy identity is a different seed, not a view of the same one.
 */
export const identityVaultIdFor = (profile: ProfileId): string =>
  profile === DEFAULT_PROFILE_ID ? IDENTITY_VAULT_ID : `${IDENTITY_VAULT_ID}/${profile}`

const activeIdentityVaultId = (): string => identityVaultIdFor(getActiveProfile())

/** True when an identity seed is stored on this device. Never prompts. */
export const hasIdentityMnemonic = (): Promise<boolean> =>
  Effect.runPromise(createEnclaveMnemonicVault().has(activeIdentityVaultId()))

/**
 * Store `mnemonic` as the identity seed. Writing does not fire the OS
 * biometric prompt (only retrieval does).
 *
 * Also derives and persists the identity's Cardano key hashes, here and not
 * later: transaction review identifies the ID by those hashes, and doing it
 * lazily would mean a biometric prompt just to label a party (see
 * `identity-cardano-creds.ts`). Derivation failure propagates — this is the one
 * place that still holds the mnemonic.
 */
export const storeIdentityMnemonic = async (mnemonic: string, authPrompt?: string): Promise<void> => {
  await Effect.runPromise(createEnclaveMnemonicVault().store(activeIdentityVaultId(), mnemonic, authPrompt))
  await persistIdentityCardanoCreds(mnemonic)
}

/**
 * Decrypt the identity seed — fires the OS biometric / device-passcode
 * prompt. Fails with the vault's typed errors (`not-found` when no identity
 * exists; see credential-vault/types.ts).
 */
export const retrieveIdentityMnemonic = (authPrompt?: string): Promise<Mnemonic> =>
  Effect.runPromise(createEnclaveMnemonicVault().retrieve(activeIdentityVaultId(), authPrompt))

/** Remove the identity seed (identity reset — sign-out is not enough). */
export const deleteIdentityMnemonic = async (): Promise<void> => {
  await Effect.runPromise(createEnclaveMnemonicVault().delete(activeIdentityVaultId()))
  await clearIdentityCardanoCreds()
}

/** A fresh 24-word identity seed (same strength as wallet-group quickstart). */
export const generateIdentityMnemonic = (): string => generateMnemonic(wordlist, 256)
