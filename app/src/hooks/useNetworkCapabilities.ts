/**
 * React binding for the network capability table.
 *
 * The rules live in `config/network-capabilities.ts` (pure, tested); this hook
 * just binds them to the selected network so components read
 * `swapEnabled` / `showFiat` / `adaTicker` instead of comparing network strings.
 *
 * @module
 */

import {useMemo} from 'react'
import {type NetworkCapabilities, networkCapabilities} from '../config/network-capabilities'
import {useConfig} from '../providers/ConfigProvider'

export type {NetworkCapabilities} from '../config/network-capabilities'

/** Capabilities of the currently selected network. */
export const useNetworkCapabilities = (): NetworkCapabilities => {
  const {network} = useConfig()
  return useMemo(() => networkCapabilities(network), [network])
}
