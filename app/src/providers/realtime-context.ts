/**
 * The realtime context and the hook that reads it.
 *
 * ⚠️ **Its own module because a hook cannot import the provider that uses it.**
 * `PnyxSessionProvider` runs `useDmKeyPackagePool`, that hook needs `useRealtime`, and
 * `RealtimeProvider` needs `usePnyxSession` — a three-module loop that Metro flags as able to
 * "result in uninitialized values". All three load while the app boots, which is where an
 * `undefined` import is worst. Nothing here imports a provider.
 *
 * @module
 */

import {createContext, useContext} from 'react'
import {logger} from '../logger'
import type {RealtimeListener} from '../services/realtime/client'

export type RealtimeContextValue = {
  /** Subscribe to signals. Returns an unsubscribe. Safe to call with no connection — a no-op. */
  readonly subscribe: (listener: RealtimeListener) => () => void
  /** Whether a socket is currently up, for diagnostics and for screens that show a live indicator. */
  readonly isConnected: boolean
}

/**
 * The default, for a consumer that is **not** below `RealtimeProvider`.
 *
 * ⚠️ It cannot deliver anything, so it says so. `useDmInvites` used to run inside
 * `PnyxSessionProvider` — an *ancestor* of the provider — and silently received this: no
 * `dm-waiting` signal and no reconnect drain ever reached it, so a peer's invite sat untaken on the
 * server and their messages stayed undecryptable. React does not warn about reading a context from
 * above its provider, so this log is the only thing that would have.
 */
export const RealtimeContext = createContext<RealtimeContextValue>({
  subscribe: () => {
    logger.warn('realtime subscribe with no provider above it — this listener receives nothing', {
      origin: 'realtime-context',
    })
    return () => {}
  },
  isConnected: false,
})

export const useRealtime = (): RealtimeContextValue => useContext(RealtimeContext)
