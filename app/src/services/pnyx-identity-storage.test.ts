import {bech32m} from '@scure/base'
import {beforeEach, describe, expect, it, vi} from 'vitest'

const {mocks} = vi.hoisted(() => ({
  mocks: {
    getSync: vi.fn<(key: string) => string | null>(),
    set: vi.fn<(key: string, value: string) => Promise<void>>(),
    remove: vi.fn<(key: string) => Promise<void>>(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../platform/storage', () => ({
  storage: {getSync: mocks.getSync, set: mocks.set, remove: mocks.remove},
}))

vi.mock('../logger', () => ({
  logger: {warn: mocks.warn, info: vi.fn(), debug: mocks.debug, error: vi.fn()},
}))

const {readPnyxIdentitySync} = await import('./pnyx-identity-storage')

/** A real `pnyx_id`, network-free and unversioned — what this build writes and can read back. */
const CURRENT = 'pnyx_id1c6jwv36qnfljuc4kxmhpkywzc90hlfrnx66elpy465y726nd48wssgnxwj'

describe('reading the last-known identity', () => {
  beforeEach(() => {
    mocks.getSync.mockReset()
    mocks.warn.mockReset()
    mocks.debug.mockReset()
  })

  it('returns an id this build can decode', () => {
    mocks.getSync.mockReturnValue(JSON.stringify({pnyxId: CURRENT, network: 'preprod'}))
    expect(readPnyxIdentitySync()).toEqual({pnyxId: CURRENT, network: 'preprod'})
  })

  it('reads nothing when nothing is stored', () => {
    mocks.getSync.mockReturnValue(null)
    expect(readPnyxIdentitySync()).toBeUndefined()
  })

  it('treats an id from before the network-free freeze as signed out, and says so', () => {
    // Re-encoded under the old network-scoped HRP so its checksum is *valid* — otherwise this would
    // pass on a checksum failure and never reach the HRP branch it claims to cover.
    const preFreeze = bech32m.encode('pnyx_id_preprod', bech32m.decode(CURRENT, false).words, false)
    expect(() => bech32m.decode(preFreeze, false)).not.toThrow()
    mocks.getSync.mockReturnValue(JSON.stringify({pnyxId: preFreeze, network: 'preprod'}))

    expect(readPnyxIdentitySync()).toBeUndefined()
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('not readable by this build'),
      expect.objectContaining({error: expect.stringContaining("unexpected HRP 'pnyx_id_preprod'")}),
    )
  })

  it('treats an id with a broken checksum as signed out, and says so', () => {
    mocks.getSync.mockReturnValue(JSON.stringify({pnyxId: `${CURRENT.slice(0, -1)}q`, network: 'preprod'}))

    expect(readPnyxIdentitySync()).toBeUndefined()
    expect(mocks.warn).toHaveBeenCalledTimes(1)
  })

  it('treats an unparseable record as signed out, and says so', () => {
    mocks.getSync.mockReturnValue('{not json')

    expect(readPnyxIdentitySync()).toBeUndefined()
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be parsed'),
      expect.objectContaining({error: expect.any(String)}),
    )
  })

  it('treats a stored address as signed out rather than as an identity', () => {
    mocks.getSync.mockReturnValue(JSON.stringify({mn_addr: 'mn_shield-addr_test1abc', network: 'preprod'}))

    expect(readPnyxIdentitySync()).toBeUndefined()
    expect(mocks.debug).toHaveBeenCalled()
  })
})
