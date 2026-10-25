import {describe, expect, it} from 'vitest'
import {delegationState} from './circle-invite-delegation'

const bytes = (fill: number) => new Uint8Array(32).fill(fill)
const hex = (fill: number) => fill.toString(16).padStart(2, '0').repeat(32)

describe('delegationState', () => {
  it('is `none` when the contract has delegated to nobody', () => {
    expect(delegationState(undefined, hex(0xaa), false)).toBe('none')
  })

  it('is `ours` when the cell holds the commitment we publish', () => {
    expect(delegationState(bytes(0xaa), hex(0xaa), false)).toBe('ours')
  })

  it('compares case-insensitively, because hex casing is not part of the value', () => {
    expect(delegationState(bytes(0xab), hex(0xab).toUpperCase(), false)).toBe('ours')
  })

  it('is `other` when somebody else holds it', () => {
    expect(delegationState(bytes(0xbb), hex(0xaa), false)).toBe('other')
  })

  // Something holds this circle's gate and it is demonstrably not a commitment we could name.
  it('is `other` when the service did not tell us what ours would be', () => {
    expect(delegationState(bytes(0xbb), null, false)).toBe('other')
  })

  // ⚠️ The failure this module exists for. Rendering a failed read as "off" invites a founder to redo
  // a delegation that is already live — a sponsored transaction that changes nothing.
  it('is `unknown` when the chain read failed, never `none`', () => {
    expect(delegationState(undefined, hex(0xaa), true)).toBe('unknown')
    expect(delegationState(bytes(0xaa), hex(0xaa), true)).toBe('unknown')
  })
})
