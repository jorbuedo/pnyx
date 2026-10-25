/**
 * Who is listening to the realtime socket, kept separately from the socket itself.
 *
 * ⚠️ **A subscriber routinely arrives before the connection does.** React runs a child's effects
 * before its parent's, so everything below `RealtimeProvider` subscribes on the render where the
 * provider has not created its connection yet. The provider used to answer those with a no-op
 * unsubscribe and forget them, which is how `useDmInvites` ended up registered with nothing: no
 * `dm-waiting` signal and no reconnect ever reached it, invites were drained only by the one-shot
 * mount effect, and an invited peer's messages stayed undecryptable.
 *
 * So membership lives here and outlives any one connection: listeners are attached to each
 * connection as it arrives and re-attached to whatever replaces it.
 *
 * @module
 */

import type {RealtimeListener} from './client'

/** The part of a connection this needs — narrower than `RealtimeConnection` so tests need no socket. */
export type ListenerSink = {
  subscribe(listener: RealtimeListener): () => void
}

export type ListenerRegistry = {
  /** Register a listener, attaching it now if a connection is already present. Returns an unsubscribe. */
  add(listener: RealtimeListener): () => void
  /** Attach every known listener to `sink` — called when a connection is created. */
  attachAll(sink: ListenerSink): void
  /** Drop the attachments, keeping the listeners: the connection went away, the subscribers did not. */
  detachAll(): void
  /** How many listeners are registered, for the provider's log line. */
  size(): number
}

export const createListenerRegistry = (): ListenerRegistry => {
  const listeners = new Set<RealtimeListener>()
  const detach = new Map<RealtimeListener, () => void>()
  let sink: ListenerSink | undefined

  const attach = (to: ListenerSink, listener: RealtimeListener): void => {
    detach.get(listener)?.()
    detach.set(listener, to.subscribe(listener))
  }

  return {
    add: (listener) => {
      listeners.add(listener)
      if (sink !== undefined) attach(sink, listener)
      return () => {
        listeners.delete(listener)
        detach.get(listener)?.()
        detach.delete(listener)
      }
    },
    attachAll: (next) => {
      sink = next
      for (const listener of listeners) attach(next, listener)
    },
    detachAll: () => {
      sink = undefined
      detach.clear()
    },
    size: () => listeners.size,
  }
}
