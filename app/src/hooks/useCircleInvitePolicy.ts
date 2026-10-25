/**
 * A circle's self-service entry rules, for the two surfaces that ask.
 *
 * One fetcher because the community panel and the join sheet want the same answer at the same
 * moment — the panel to say what a circle asks before anyone taps Join, the sheet to put the rules
 * beside the wallet picker.
 *
 * ⚠️ **Three states, not two.** `null` is "this community has no self-service path" and is a real
 * answer; `undefined` is "we have not got one", which a caller must render as loading rather than as
 * an absence. A failed read stays `undefined` and is logged: an unreachable service and a circle
 * that admits nobody must not look alike.
 *
 * @module
 */

import {useCallback, useEffect, useState} from 'react'
import {logger} from '../logger'
import {usePnyxSession} from '../providers'
import {type InviteRule, pnyxApi} from '../services/pnyx-api'

const ORIGIN = 'useCircleInvitePolicy'

export type CircleInvitePolicy = {
  /** `null` when the circle offers no self-service path; `undefined` until an answer arrives. */
  readonly rules: readonly InviteRule[] | null | undefined
  readonly reload: () => Promise<void>
}

/**
 * @param circleId The circle to read. `undefined` reads nothing.
 * @param enabled Skip the read entirely — an open circle asks nothing, so it has no policy to show.
 */
export const useCircleInvitePolicy = (circleId: string | undefined, enabled = true): CircleInvitePolicy => {
  const {session} = usePnyxSession()
  const token = session?.token
  const [rules, setRules] = useState<readonly InviteRule[] | null | undefined>(undefined)

  const reload = useCallback(async () => {
    if (token === undefined || circleId === undefined || !enabled) return
    try {
      setRules((await pnyxApi.getCircleInvitePolicy(token, circleId)).rules)
    } catch (e) {
      logger.warn('could not read the joining requirements', {origin: ORIGIN, circleId, error: String(e)})
    }
  }, [token, circleId, enabled])

  useEffect(() => {
    void reload()
  }, [reload])

  return {rules, reload}
}
