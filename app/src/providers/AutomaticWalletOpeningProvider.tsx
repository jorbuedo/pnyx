/**
 * Automatic wallet opening provider.
 *
 * Kept as a pass-through wrapper for structural compatibility.
 * Auto-opening was removed: the app always starts on the "all blockchains"
 * aggregate page with no wallet pre-selected.
 *
 * @module
 */

import {createContext, type ReactNode} from 'react'

export type AutomaticWalletOpeningContextValue = object

export const AutomaticWalletOpeningContext = createContext<AutomaticWalletOpeningContextValue | null>(null)

export type AutomaticWalletOpeningProviderProps = {
  children: ReactNode
}

export function AutomaticWalletOpeningProvider({children}: AutomaticWalletOpeningProviderProps) {
  return <AutomaticWalletOpeningContext.Provider value={{}}>{children}</AutomaticWalletOpeningContext.Provider>
}
