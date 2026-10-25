import {describe, expect, it, vi} from 'vitest'

import {notifyStoreChange, onStoreChange} from './store-change'

describe('onStoreChange', () => {
  it('runs every listener on the topic that was written', () => {
    const first = vi.fn()
    const second = vi.fn()
    const off = [onStoreChange('midnight-dust', first), onStoreChange('midnight-dust', second)]

    notifyStoreChange('midnight-dust')

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
    for (const stop of off) stop()
  })

  it('does not run listeners on another topic', () => {
    const dust = vi.fn()
    const off = onStoreChange('midnight-dust', dust)

    notifyStoreChange('midnight-unshielded')

    expect(dust).not.toHaveBeenCalled()
    off()
  })

  it('stops running a listener once it unsubscribes', () => {
    const listener = vi.fn()
    onStoreChange('midnight-shielded', listener)()

    notifyStoreChange('midnight-shielded')

    expect(listener).not.toHaveBeenCalled()
  })

  // A component unmounting in response to a change unsubscribes itself mid-notification. Iterating the
  // live set would then skip whichever listener happened to come next — a screen silently left stale by
  // an unrelated one closing, which is the exact class of bug this module exists to remove.
  it('still notifies the rest when a listener unsubscribes itself', () => {
    const later = vi.fn()
    let offSelf: (() => void) | undefined
    offSelf = onStoreChange('midnight-unshielded', () => offSelf?.())
    const offLater = onStoreChange('midnight-unshielded', later)

    notifyStoreChange('midnight-unshielded')

    expect(later).toHaveBeenCalledTimes(1)
    offLater()
  })

  it('is a no-op for a topic nobody listens to', () => {
    expect(() => notifyStoreChange('midnight-pending-sends')).not.toThrow()
  })
})
