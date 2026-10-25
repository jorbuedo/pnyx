import {describe, expect, it, vi} from 'vitest'
import {resolveDeviceLock} from './device-lock-gate'

describe('resolveDeviceLock', () => {
  it('probes when nothing has been prewarmed', async () => {
    const probe = vi.fn().mockResolvedValue(true)
    const {capable} = await resolveDeviceLock(null, probe)
    expect(capable).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('reuses a prewarmed yes without touching the device again', async () => {
    // The whole point: by tap time the answer is already in hand, so the tap navigates at once.
    const probe = vi.fn().mockResolvedValue(true)
    const {capable} = await resolveDeviceLock(Promise.resolve(true), probe)
    expect(capable).toBe(true)
    expect(probe).not.toHaveBeenCalled()
  })

  it('re-probes a remembered no', async () => {
    // ⚠️ The regression this exists to prevent: the user is sent to device-lock-required, sets a
    // lock, and comes back to a screen that never unmounted. A remembered `false` would send them
    // straight back for a problem they had just fixed.
    const probe = vi.fn().mockResolvedValue(true)
    const {capable} = await resolveDeviceLock(Promise.resolve(false), probe)
    expect(capable).toBe(true)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('keeps a yes for the next tap and keeps nothing on a no', async () => {
    const yes = await resolveDeviceLock(null, () => Promise.resolve(true))
    expect(await yes.cache).toBe(true)
    const no = await resolveDeviceLock(null, () => Promise.resolve(false))
    expect(no.cache).toBeNull()
  })

  it('still reports incapable when the device has no lock', async () => {
    const {capable} = await resolveDeviceLock(null, () => Promise.resolve(false))
    expect(capable).toBe(false)
  })
})
