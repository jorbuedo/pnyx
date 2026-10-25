/**
 * Minimal EventEmitter for React Native compatibility.
 *
 * Replaces `node:events` which Metro bundler cannot resolve on mobile.
 * Supports only the subset used by trezor-native: on, off, once, emit, removeAllListeners.
 */

type Listener = (...args: unknown[]) => void

export const createEventEmitter = () => {
  const listeners = new Map<string, Set<Listener>>()
  /** Per-event map of original fn → once wrapper so off() can remove once-registered listeners */
  const onceWrappers = new Map<string, Map<Listener, Listener>>()

  const getSet = (event: string) => {
    let set = listeners.get(event)
    if (!set) {
      set = new Set()
      listeners.set(event, set)
    }
    return set
  }

  return {
    on: (event: string, fn: Listener) => {
      getSet(event).add(fn)
    },
    off: (event: string, fn: Listener) => {
      const set = listeners.get(event)
      if (!set) return
      // Try removing directly first, then check for a once wrapper
      if (!set.delete(fn)) {
        const eventWrappers = onceWrappers.get(event)
        const wrapper = eventWrappers?.get(fn)
        if (wrapper) set.delete(wrapper)
      }
      onceWrappers.get(event)?.delete(fn)
    },
    once: (event: string, fn: Listener) => {
      const wrapper: Listener = (...args) => {
        listeners.get(event)?.delete(wrapper)
        onceWrappers.get(event)?.delete(fn)
        fn(...args)
      }
      let eventWrappers = onceWrappers.get(event)
      if (!eventWrappers) {
        eventWrappers = new Map()
        onceWrappers.set(event, eventWrappers)
      }
      eventWrappers.set(fn, wrapper)
      getSet(event).add(wrapper)
    },
    emit: (event: string, ...args: unknown[]) => {
      const set = listeners.get(event)
      if (set) [...set].forEach((fn) => fn(...args))
    },
    removeAllListeners: () => {
      listeners.clear()
      onceWrappers.clear()
    },
  }
}

export type EventEmitter = ReturnType<typeof createEventEmitter>
