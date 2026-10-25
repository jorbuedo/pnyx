import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

import type {MidnightSyncKeys} from './sync-keys-store'

/** 11×abandon + about — the standard all-zero-entropy test vector. */
const MNEMONIC = `${'abandon '.repeat(11)}about`

const warn = vi.fn()
vi.mock('../../logger', () => ({logger: {debug: vi.fn(), info: vi.fn(), warn, error: vi.fn()}}))

type BookAppend = (groupId: string, accountIndex: number, keys: readonly MidnightSyncKeys[]) => Effect.Effect<void>

const appendDustKeysToBook = vi.fn<BookAppend>(() => Effect.void)
vi.mock('./dust-key-book', () => ({
  appendDustKeysToBook: (...args: Parameters<BookAppend>) => appendDustKeysToBook(...args),
}))
vi.mock('./networks', () => ({knownMidnightNetworks: () => ['mainnet', 'preprod', 'preview']}))

/** The one call's third argument, failing the test rather than widening to `undefined`. */
const appendedKeys = (call = 0): readonly MidnightSyncKeys[] => {
  const args = appendDustKeysToBook.mock.calls[call]
  if (args === undefined) throw new Error(`appendDustKeysToBook was not called ${call + 1} time(s)`)
  return args[2]
}

const {rememberSyncKeys, rememberSyncKeysForScheduler} = await import('./sync-keys')
const {getSyncKeys} = await import('./sync-keys-store')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('rememberSyncKeysForScheduler', () => {
  it('never fails its caller, and says so when it could not', async () => {
    // ⚠️ The contract that matters: this runs on a money path off the back of an approved send. If a key
    // the *scheduler* wanted cannot be derived, the send must still complete — and the failure must not
    // be silent, because a send that quietly leaves no keys is a wallet that quietly stops keeping DUST
    // current, which is the whole defect this exists to close.
    await expect(
      rememberSyncKeysForScheduler('g1', 0, 'not a real mnemonic at all', 'preprod'),
    ).resolves.toBeUndefined()
    expect(getSyncKeys('g1', 0, 'preprod')).toBeUndefined()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('dust will stay stale')
  })
})

describe('rememberSyncKeys', () => {
  it('derives every known network from the one prompt', async () => {
    // ⚠️ **This is what stops a network switch stranding a wallet.** Re-deriving needs the seed, and a
    // scheduled tick is deliberately not allowed to raise a biometric prompt — so a key that only
    // exists for the network the user happened to be on when they last refreshed is a key the
    // scheduler can never obtain for the network they switch to. The DUST role key has no network in
    // its derivation path, so covering every network costs one address encoding each.
    const own = await rememberSyncKeys('group-aaaa', 0, MNEMONIC, 'preprod')

    expect(own.network).toBe('preprod')
    expect(appendDustKeysToBook).toHaveBeenCalledTimes(1)
    expect(appendDustKeysToBook).toHaveBeenCalledWith('group-aaaa', 0, expect.anything())
    const derived = appendedKeys()
    expect([...derived].map((one) => one.network).sort()).toEqual(['mainnet', 'preprod', 'preview'])

    // One role key across all of them — the addresses differ, the spending material does not.
    expect(new Set(derived.map((one) => one.dust.join(','))).size).toBe(1)
    expect(new Set(derived.map((one) => one.dustAddress)).size).toBe(3)
    expect(derived.find((one) => one.network === 'preprod')?.dustAddress).toBe(own.dustAddress)
  })

  it('covers a network this build has no endpoints for, when the user is on it', async () => {
    // `knownMidnightNetworks` is the endpoint table, not the set of networks a wallet can be on. A
    // caller asking for one outside it still gets a key — refusing would be the stranding again.
    await rememberSyncKeys('group-aaaa', 0, MNEMONIC, 'devnet')

    expect([...appendedKeys()].map((one) => one.network).sort()).toEqual(['devnet', 'mainnet', 'preprod', 'preview'])
  })
})
