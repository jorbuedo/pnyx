/**
 * Onboarding provider for holding sensitive data in-memory during wallet setup.
 *
 * Mnemonics must never appear in URL route params (they leak into browser
 * history, the URL bar, Referer headers, and devtools). This provider holds
 * them in React state so they live only in memory.
 *
 * @module
 */

import type {WalletSource} from '@pnyx/wallet'
import {createContext, type ReactNode, useCallback, useContext, useState} from 'react'
import {createInitialOnboardingState, resetOnboardingState, setOnboardingMnemonic} from './onboarding-state'

type OnboardingContextValue = {
  mnemonic: string | null
  setMnemonic: (m: string | null) => void
  isQuickStart: boolean
  setIsQuickStart: (value: boolean) => void
  isRestore: boolean
  setIsRestore: (value: boolean) => void
  recoveredBirthdays: Readonly<Record<string, number>> | null
  setRecoveredBirthdays: (birthdays: Readonly<Record<string, number>> | null) => void
  isAddWallet: boolean
  setIsAddWallet: (value: boolean) => void
  proposedWalletName: string | null
  setProposedWalletName: (name: string | null) => void
  existingGroupId: string | null
  existingGroupSource: WalletSource | null
  setExistingGroupMatch: (match: {groupId: string; source: WalletSource} | null) => void
  reset: () => void
}

const OnboardingContext = createContext<OnboardingContextValue | null>(null)

export function OnboardingProvider({children}: {children: ReactNode}) {
  const [state, setState] = useState(createInitialOnboardingState)

  const setMnemonic = useCallback((nextMnemonic: string | null) => {
    setState((current) => setOnboardingMnemonic(current, nextMnemonic))
  }, [])

  const setIsQuickStart = useCallback((value: boolean) => {
    setState((current) => ({...current, isQuickStart: value}))
  }, [])

  const setIsRestore = useCallback((value: boolean) => {
    setState((current) => ({...current, isRestore: value}))
  }, [])

  const setRecoveredBirthdays = useCallback((birthdays: Readonly<Record<string, number>> | null) => {
    setState((current) => ({...current, recoveredBirthdays: birthdays}))
  }, [])

  const setIsAddWallet = useCallback((value: boolean) => {
    setState((current) => ({...current, isAddWallet: value}))
  }, [])

  const setProposedWalletName = useCallback((name: string | null) => {
    setState((current) => ({...current, proposedWalletName: name}))
  }, [])

  const setExistingGroupMatch = useCallback((match: {groupId: string; source: WalletSource} | null) => {
    setState((current) => ({
      ...current,
      existingGroupId: match?.groupId ?? null,
      existingGroupSource: match?.source ?? null,
    }))
  }, [])

  const reset = useCallback(() => {
    setState(resetOnboardingState())
  }, [])

  return (
    <OnboardingContext.Provider
      value={{
        mnemonic: state.mnemonic,
        isQuickStart: state.isQuickStart,
        isRestore: state.isRestore,
        recoveredBirthdays: state.recoveredBirthdays,
        isAddWallet: state.isAddWallet,
        proposedWalletName: state.proposedWalletName,
        existingGroupId: state.existingGroupId,
        existingGroupSource: state.existingGroupSource,
        setMnemonic,
        setIsQuickStart,
        setIsRestore,
        setRecoveredBirthdays,
        setIsAddWallet,
        setProposedWalletName,
        setExistingGroupMatch,
        reset,
      }}
    >
      {children}
    </OnboardingContext.Provider>
  )
}

export function useOnboarding(): OnboardingContextValue {
  const ctx = useContext(OnboardingContext)
  if (!ctx) {
    throw new Error('useOnboarding must be used within an OnboardingProvider')
  }
  return ctx
}
