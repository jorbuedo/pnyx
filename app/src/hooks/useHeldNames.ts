/**
 * The names this identity holds, verified against the chain.
 *
 * The list comes from the contact card and the identity row ({@link mergeHeldNames} says why it can
 * come from nowhere else). Each is then checked against its own handle contract, because a card row is
 * a claim the contract never validated — rendering one as owned without checking would be the same
 * mistake as trusting `primaryName` without the bidirectional rule.
 *
 * ⚠️ **Showing a name is claiming it**, so the claim is exposed from here rather than taken from a
 * second `useHandleActions`. A screen holding its own copy of that hook writes the card through an
 * instance this one cannot see, and the list then renders the state it had before the claim.
 *
 * @module
 */

import {decodePnyxId} from '@pnyx/contract-client/identity'
import {useCallback, useEffect, useState} from 'react'
import {logger} from '../logger'
import {usePnyxSession} from '../providers'
import {readNameOwnership} from '../services/handle-resolve'
import {type HeldName, type HeldNameStatus, mergeHeldNames} from '../services/held-names'
import {useContactCard} from './useContactCard'
import {useHandleActions} from './useHandleActions'

const ORIGIN = 'useHeldNames'

export type HeldNamesState = {
  readonly names: readonly HeldName[]
  readonly loading: boolean
  /** True while a claim is proving or relaying. */
  readonly busy: boolean
  /** Show one of these names to others. Refreshes the list once the chain agrees. */
  readonly claim: (display: string) => Promise<void>
  /** Re-read the card and the row — for a screen coming back into view after a claim elsewhere. */
  readonly refresh: () => Promise<void>
}

export const useHeldNames = (): HeldNamesState => {
  const {reload: reloadCard} = useContactCard()
  const {handle, busy, claim: claimName, refresh: refreshHandle} = useHandleActions()
  const {identity} = usePnyxSession()
  const [names, setNames] = useState<readonly HeldName[]>([])
  const [loading, setLoading] = useState(true)

  const pnyxId = identity?.pnyxId

  const resolve = useCallback(async () => {
    if (pnyxId === undefined) {
      setNames([])
      setLoading(false)
      return
    }
    // Unverified first, so the screen has something to show while the reads run.
    const provisional = mergeHeldNames({activeName: handle, statusOf: () => 'unknown'})
    setNames(provisional)

    const identityBytes = decodePnyxId(pnyxId).identity
    const verdicts = new Map<string, HeldNameStatus>()
    for (const name of provisional) {
      const held = await readNameOwnership(name.canonical, identityBytes).catch((error: unknown) => {
        // ⚠️ A failed read is `unknown`, never `not-owned` — an outage must not tell someone a name
        // they hold is not theirs.
        logger.warn('a held name could not be verified', {origin: ORIGIN, error: String(error)})
        return 'unknown' as const
      })
      verdicts.set(name.canonical, held === 'mine' ? 'owned' : held === 'unknown' ? 'unknown' : 'not-owned')
    }
    setNames(mergeHeldNames({activeName: handle, statusOf: (c) => verdicts.get(c) ?? 'unknown'}))
    // A list that renders nothing and a list that read nothing look identical on screen.
    logger.debug('held names resolved', {
      origin: ORIGIN,
      shown: handle ?? null,
      listed: provisional.length,
    })
    setLoading(false)
  }, [pnyxId, handle])

  useEffect(() => {
    void resolve()
  }, [resolve])

  /**
   * Re-read both sources, which is what a refresh has to mean here.
   *
   * The card and the row are read by two hooks that each cache their answer, and a claim moves both —
   * so refreshing one leaves the list half-current. `resolve` re-runs on whatever changed; when nothing
   * did, the verdicts already describe the same inputs and there is nothing to redo.
   */
  const refresh = useCallback(async () => {
    await Promise.all([reloadCard(), refreshHandle()])
    // A refresh that finds nothing changed re-runs no resolve and would otherwise leave no trace, which
    // is indistinguishable from one that never ran.
    logger.debug('re-read the card and the row', {origin: ORIGIN})
  }, [reloadCard, refreshHandle])

  const claim = useCallback(
    async (display: string) => {
      await claimName(display)
      // `claimName` waits for the row on its own copy of the handle, which does not reach the reads
      // this list is built from.
      await refresh()
    },
    [claimName, refresh],
  )

  return {names, loading, busy, claim, refresh}
}
