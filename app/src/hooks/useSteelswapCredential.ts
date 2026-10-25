/**
 * The SteelSwap credential's state, as React state.
 *
 * Phase 0.4 of the integration plan: before this, a failed mint degraded to "no
 * price" and "no tokens" everywhere, which is indistinguishable from a token
 * that genuinely has no price — the exact confusion the every-error-path-logs
 * rule exists to prevent. The store is written by `steelswap-auth`; this is the
 * half that lets a screen say *why* it is empty.
 *
 * @module
 */

import {useEffect, useState} from 'react'
import {
  type SteelswapCredentialState,
  steelswapCredentialState,
  subscribeSteelswapCredential,
} from '../services/cardano-assets/steelswap-credential-state'

export const useSteelswapCredential = (): SteelswapCredentialState => {
  const [state, setState] = useState<SteelswapCredentialState>(steelswapCredentialState)

  useEffect(() => {
    // Re-read on mount: the mint may have resolved between the initial state
    // read and the subscription.
    setState(steelswapCredentialState())
    return subscribeSteelswapCredential(setState)
  }, [])

  return state
}
