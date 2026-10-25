/**
 * Community list + joined-state for the home rail. Joined state fans out one
 * getCircle per community because the list endpoint carries no membership
 * info — fine at v0 scale. Fixing the fan-out means adding membership to the
 * list endpoint; the 5s badge polling below needs a push primitive the
 * Worker/D1 backend does not have.
 *
 * @module
 */

import {useFocusEffect} from 'expo-router'
import {useCallback, useEffect, useState} from 'react'
import {logger} from '../../logger'
import {usePnyxSession} from '../../providers'
import {type Circle, pnyxApi} from '../../services/pnyx-api'

export type Communities = {
  readonly circles: readonly Circle[] | undefined
  readonly joinedIds: ReadonlySet<string>
  readonly error: string | undefined
  readonly isLoading: boolean
  readonly refresh: () => void
}

export function useCommunities(): Communities {
  const {session} = usePnyxSession()
  const token = session?.token

  const [circles, setCircles] = useState<readonly Circle[] | undefined>(undefined)
  const [joinedIds, setJoinedIds] = useState<ReadonlySet<string>>(new Set())
  const [error, setError] = useState<string | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(false)

  const refresh = useCallback(() => {
    setIsLoading(true)
    pnyxApi
      .listCircles()
      .then(async ({circles: list}) => {
        setCircles(list)
        setError(undefined)
        if (token === undefined) {
          setJoinedIds(new Set())
          return
        }
        const views = await Promise.all(
          list.map((circle) =>
            pnyxApi
              .getCircle(circle.id, token)
              .then((view) => (view.membership === null ? undefined : circle.id))
              .catch((e) => {
                logger.warn('Circle read failed; membership for it is unknown', {
                  origin: 'useCommunities',
                  circleId: circle.id,
                  error: String(e),
                })
                return undefined
              }),
          ),
        )
        setJoinedIds(new Set(views.filter((id): id is string => id !== undefined)))
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [token])

  useFocusEffect(
    useCallback(() => {
      refresh()
    }, [refresh]),
  )

  // 5s pending-badge polling — only while something is actually pending.
  const hasPending = (circles ?? []).some((circle) => circle.chain?.status === 'pending')
  useEffect(() => {
    if (!hasPending) return
    const timer = setInterval(refresh, 5_000)
    return () => clearInterval(timer)
  }, [hasPending, refresh])

  return {circles, joinedIds, error, isLoading, refresh}
}
