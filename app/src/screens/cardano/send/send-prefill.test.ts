import {describe, expect, it} from 'vitest'
import {ADA_ID, addTarget, initialSendState, type SendState, setTargetAddress, withPrefill} from './state'

const ADDRESS =
  'addr_test1qr6439dwh0f5jh57y0wkzly5d8upev2z9fnppk4hk7t8smxs4ymglwdxrz6vcajhckc7j8flvsgjskaqq9zzxz2p7r0qckpvwr'

describe('withPrefill', () => {
  it('fills the first recipient and its ADA amount', () => {
    const state = withPrefill(initialSendState(), {address: ADDRESS, lovelace: 5_000_000n})
    expect(state.targets[0]?.address).toBe(ADDRESS)
    expect(state.targets[0]?.amounts.get(ADA_ID)).toBe(5_000_000n)
  })

  it('leaves the address unresolved, so the screen still validates it', () => {
    // A link asserting its own address is valid is a link that skips the check.
    const state = withPrefill(initialSendState(), {address: ADDRESS, lovelace: null})
    expect(state.targets[0]?.resolvedAddressHex).toBeNull()
  })

  it('leaves the amount alone for an open request', () => {
    const state = withPrefill(initialSendState(), {address: ADDRESS, lovelace: null})
    expect(state.targets[0]?.amounts.get(ADA_ID)).toBe(0n)
  })

  it('never overwrites a recipient the user already typed', () => {
    // The dangerous direction: money to an address they did not pick. Whatever is
    // already there wins, so a prefill arriving mid-compose is ignored.
    const typed: SendState = setTargetAddress(initialSendState(), 0, 'addr_test1typed')
    const state = withPrefill(typed, {address: ADDRESS, lovelace: 5_000_000n})
    expect(state).toBe(typed)
  })

  it('leaves the other recipients untouched', () => {
    const two: SendState = addTarget(setTargetAddress(addTarget(initialSendState()), 1, 'b'))
    const state = withPrefill(two, {address: ADDRESS, lovelace: 1n})
    expect(state.targets).toHaveLength(3)
    expect(state.targets[0]?.address).toBe(ADDRESS)
    expect(state.targets[1]?.address).toBe('b')
  })
})
