/**
 * Verified-token set for the portfolio's spam filter. Shares the persisted,
 * session-memoised registry with the swap picker (`getVerifiedTokens`), so
 * enabling the filter costs no extra fetch. Paints from the sync cache first.
 *
 * @module
 */

import {useEffect, useState} from 'react'

import {logger} from '../logger'
import {
  getVerifiedTokens,
  readVerifiedTokensSync,
  type VerifiedTokens,
} from '../services/cardano-assets/verified-tokens'

export type UseVerifiedTokens = {
  readonly verifiedIds: ReadonlySet<string>
  /** True until the registry has resolved (sync cache miss + fetch pending). */
  readonly loading: boolean
}

const EMPTY: ReadonlySet<string> = new Set()

export const useVerifiedTokens = (): UseVerifiedTokens => {
  const [state, setState] = useState<VerifiedTokens | null>(() => readVerifiedTokensSync())

  useEffect(() => {
    let active = true
    void getVerifiedTokens(Date.now())
      .then((v) => {
        if (active) setState(v)
      })
      .catch((error: unknown) => {
        // Was an unhandled rejection. `state` stays null, which this hook reports as `loading` — so a
        // failed registry read presented as a permanent spinner with nothing on record.
        logger.warn('the verified-token registry could not be read', {
          origin: 'verified-tokens',
          error: String(error),
        })
      })
    return () => {
      active = false
    }
  }, [])

  return {verifiedIds: state?.verifiedIds ?? EMPTY, loading: state === null}
}
