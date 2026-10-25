import {createContext, type ReactNode, useContext} from 'react'
import type {HandleQrActionOptions} from '../utils/qr-actions'

const DeepLinkOptionsContext = createContext<HandleQrActionOptions | undefined>(undefined)

export function DeepLinkOptionsProvider({
  children,
  options,
}: {
  readonly children: ReactNode
  readonly options?: HandleQrActionOptions
}) {
  return <DeepLinkOptionsContext.Provider value={options}>{children}</DeepLinkOptionsContext.Provider>
}

export function useDeepLinkOptions(): HandleQrActionOptions | undefined {
  return useContext(DeepLinkOptionsContext)
}
