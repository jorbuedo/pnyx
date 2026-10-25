import type {WalletSource} from '@pnyx/wallet'

export type OnboardingState = {
  mnemonic: string | null
  isQuickStart: boolean
  isRestore: boolean
  /**
   * Midnight shielded birthdays (network -> block height) carried out of a **passkey** restore, to be
   * written against the new group id `preparing.tsx` creates.
   *
   * ⚠️ **Only ever set by the passkey path**, never read from the local blob at the point of use: a
   * manual mnemonic restore of a *different* seed would otherwise adopt this device's blob, and a
   * birthday later than that seed's true one skips blocks permanently.
   */
  recoveredBirthdays: Readonly<Record<string, number>> | null
  /**
   * True when this flow was entered from the in-app "Add wallet" (a funds
   * wallet group is being created), false for first-run onboarding (which
   * establishes the identity, no group). Set at the add-wallet entry point;
   * preparing.tsx branches on it so a first-run re-entry can never leak the
   * identity as a funds wallet group (identity/wallet split).
   */
  isAddWallet: boolean
  /**
   * Wallet name proposed by an upstream flow (e.g. encrypted-backup restore).
   * When set, the enclave-enrollment screen uses it as the default value
   * instead of {@link generateAutoWalletName}'s output.
   */
  proposedWalletName: string | null
  /**
   * GroupId of an existing wallet whose stored Cardano xpub matches the
   * onboarding mnemonic. When set, `preparing.tsx` upgrades that group in
   * place (adds missing chains, bumps source) instead of creating a new one.
   */
  existingGroupId: string | null
  /**
   * Original `source` of the matched existing group — preserved since the
   * wallet-manager overwrites the field as part of the upgrade.
   */
  existingGroupSource: WalletSource | null
}

export function createInitialOnboardingState(): OnboardingState {
  return {
    mnemonic: null,
    isQuickStart: false,
    isRestore: false,
    recoveredBirthdays: null,
    isAddWallet: false,
    proposedWalletName: null,
    existingGroupId: null,
    existingGroupSource: null,
  }
}

export function setOnboardingMnemonic(state: OnboardingState, mnemonic: string | null): OnboardingState {
  return {
    ...state,
    mnemonic,
    // A mnemonic assignment defaults the flow back to non-restore unless the caller
    // sets isRestore right after.
    isQuickStart: false,
    isRestore: false,
    // Cleared with it: birthdays belong to the seed that was just replaced.
    recoveredBirthdays: null,
    proposedWalletName: null,
    existingGroupId: null,
    existingGroupSource: null,
  }
}

export function resetOnboardingState(): OnboardingState {
  return createInitialOnboardingState()
}
