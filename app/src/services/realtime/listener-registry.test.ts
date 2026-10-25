import {describe, expect, it, vi} from 'vitest'
import type {RealtimeListener} from './client'
import {createListenerRegistry, type ListenerSink} from './listener-registry'

/** A sink that records its subscribers and can fire `onOpen` at them, like a socket opening. */
const fakeSink = () => {
  const listeners = new Set<RealtimeListener>()
  const sink: ListenerSink = {
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
  return {sink, open: () => listeners.forEach((l) => l.onOpen?.()), count: () => listeners.size}
}

describe('createListenerRegistry', () => {
  it('attaches a listener that subscribed before any connection existed', () => {
    // The regression: React runs a child's effects before its parent's, so this is the ordinary
    // order, not an edge case. The listener used to be dropped and never retried.
    const registry = createListenerRegistry()
    const onOpen = vi.fn()
    registry.add({onOpen})

    const {sink, open} = fakeSink()
    registry.attachAll(sink)
    open()

    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('attaches a listener that subscribes after the connection exists', () => {
    const registry = createListenerRegistry()
    const {sink, open} = fakeSink()
    registry.attachAll(sink)

    const onOpen = vi.fn()
    registry.add({onOpen})
    open()

    expect(onOpen).toHaveBeenCalledOnce()
  })

  it('re-attaches surviving listeners to the connection that replaces one that went away', () => {
    const registry = createListenerRegistry()
    const onOpen = vi.fn()
    registry.add({onOpen})

    const first = fakeSink()
    registry.attachAll(first.sink)
    registry.detachAll()

    const second = fakeSink()
    registry.attachAll(second.sink)
    second.open()

    expect(onOpen).toHaveBeenCalledOnce()
    expect(second.count()).toBe(1)
  })

  it('does not attach twice when the same listener is re-attached', () => {
    const registry = createListenerRegistry()
    const onOpen = vi.fn()
    registry.add({onOpen})

    const {sink, open} = fakeSink()
    registry.attachAll(sink)
    registry.attachAll(sink)
    open()

    expect(onOpen).toHaveBeenCalledOnce()
    expect(registry.size()).toBe(1)
  })

  it('unsubscribing detaches from the live connection and forgets the listener', () => {
    const registry = createListenerRegistry()
    const onOpen = vi.fn()
    const remove = registry.add({onOpen})

    const {sink, open, count} = fakeSink()
    registry.attachAll(sink)
    remove()
    open()

    expect(onOpen).not.toHaveBeenCalled()
    expect(count()).toBe(0)
    expect(registry.size()).toBe(0)
  })

  it('unsubscribing before any connection exists leaves nothing to attach', () => {
    const registry = createListenerRegistry()
    const onOpen = vi.fn()
    registry.add({onOpen})()

    const {sink, open} = fakeSink()
    registry.attachAll(sink)
    open()

    expect(onOpen).not.toHaveBeenCalled()
    expect(registry.size()).toBe(0)
  })
})
