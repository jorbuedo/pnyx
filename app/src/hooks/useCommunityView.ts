/**
 * Fetches a community view (details, membership, polls, discussion) and keeps it fresh from the
 * realtime socket.
 *
 * The 5s poll this replaced was honest about itself — it existed because a Worker over D1 had no
 * server-push primitive. There is one now (a Durable Object; `services/realtime/client.ts`), so a
 * settled chain ref or a new reply arrives as a signal instead of being discovered up to five seconds
 * late.
 *
 * **No interval at all.** Three mechanisms already cover every case, none of which costs anything while
 * idle: the socket's signals, a refetch on every (re)connect, and `useFocusEffect` on screen focus. A
 * timer would only add spend — a poll per user per interval is a Worker invocation per user per interval,
 * whether or not anything changed — and it would duplicate the reconnect loop, which retries at ≤30 s
 * and drains on success. If signals stop arriving, that is a deployment to fix, not something to paper
 * over on every user's battery and our request budget.
 *
 * @module
 */

import {useFocusEffect} from 'expo-router'
import {useCallback, useEffect, useState} from 'react'
import {usePnyxSession, useRealtime} from '../providers'
import {rememberCirclePeers} from '../services/circle-peers'
import {type CircleView, pnyxApi} from '../services/pnyx-api'

export function useCommunityView(id: string | undefined) {
  const {session, forumRoot} = usePnyxSession()
  const {subscribe} = useRealtime()
  const [view, setView] = useState<CircleView | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)
  const [isLoading, setIsLoading] = useState(false)

  const refresh = useCallback(() => {
    if (id === undefined) return
    setIsLoading(true)
    pnyxApi
      .getCircle(id, session?.token)
      .then((result) => {
        setView(result)
        setError(undefined)
        // Noticing who was in a view that was fetched anyway — never a fetch of its own, and never
        // awaited: the discussion is what the caller asked for. See `services/circle-peers.ts`.
        if (forumRoot !== undefined) void rememberCirclePeers(forumRoot, result.circle, result.posts)
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setIsLoading(false))
  }, [id, session?.token, forumRoot])

  useFocusEffect(
    useCallback(() => {
      refresh()
    }, [refresh]),
  )

  // Signals for this community, plus a refetch whenever the socket (re)connects — which is what makes
  // anything missed while disconnected harmless, and why there is no cursor to track.
  useEffect(() => {
    if (id === undefined) return
    return subscribe({
      onOpen: refresh,
      onEvent: (event) => {
        if (event.kind === 'dm-waiting') return
        if (event.communityId === id) refresh()
      },
    })
  }, [id, refresh, subscribe])

  return {view, error, isLoading, refresh}
}
