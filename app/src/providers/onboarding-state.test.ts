/**
 * Unit tests for `isRestore` state transitions.
 *
 * ⚠️ **The flag is diagnostic now.** Its one behavioural consumer was the subtitle on
 * `/onboarding/preparing`'s success screen, and that screen is gone — creation goes straight to the
 * app. What is left reads it only into `PreparingWallet`'s log lines, which is worth keeping (a
 * restore and a fresh create fail differently) but is not behaviour. These cases still pin the
 * transitions, so a future consumer inherits semantics that were never quietly broken.
 *
 * @module
 */

import {describe, expect, it} from 'vitest'

import {createInitialOnboardingState, resetOnboardingState, setOnboardingMnemonic} from './onboarding-state'

describe('OnboardingProvider isRestore state', () => {
  it('initial state has isRestore false', () => {
    const state = createInitialOnboardingState()

    expect(state.isRestore).toBe(false)
  })

  it('setOnboardingMnemonic resets isRestore so the flow re-asserts intent', () => {
    // Restore-flow intent set first
    const restoreState = {...createInitialOnboardingState(), isRestore: true}

    // User backs out and starts a fresh "create" flow that sets a new mnemonic
    const next = setOnboardingMnemonic(restoreState, 'fresh seed phrase')

    expect(next.mnemonic).toBe('fresh seed phrase')
    expect(next.isRestore).toBe(false)
  })

  it('setOnboardingMnemonic clears proposedWalletName so a stale name from an abandoned restore-from-backup flow does not leak into the next onboarding flow', () => {
    const stale = {...createInitialOnboardingState(), proposedWalletName: 'Backup Wallet'}

    const next = setOnboardingMnemonic(stale, 'fresh seed phrase')

    expect(next.proposedWalletName).toBeNull()
  })

  it('reset clears isRestore', () => {
    const reset = resetOnboardingState()

    expect(reset.isRestore).toBe(false)
  })
})
