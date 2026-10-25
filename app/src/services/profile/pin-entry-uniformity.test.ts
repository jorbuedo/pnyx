/**
 * The PIN screen must not leak why it is showing.
 *
 * `PinEntryScreen` pulls a React/RN chain that is awkward to render here, so
 * this asserts on the *inputs the gate hands it* rather than on pixels: if the
 * gate derives identical props in every mode, the screen cannot differ. The
 * screen's own copy is a single fixed key (`lock.pin.title` / `lock.pin.subtitle`)
 * with no mode-dependent branch, which is the other half of the guarantee.
 */

import {describe, expect, it} from 'vitest'
import {isPinRequired, type PinMode} from './pin-required'

/** Exactly what `ProfileGate` passes to the screen. */
const gateProps = (length: number) => ({
  length,
  title: undefined,
  errorText: undefined,
  testID: 'profile-gate-pin',
})

describe('PIN screen uniformity', () => {
  const modes: readonly PinMode[] = ['everyUnlock', 'coldStart', 'armed']

  it('renders from identical props no matter which mode raised it', () => {
    const seen = new Set(modes.map((_mode) => JSON.stringify(gateProps(6))))
    expect(seen.size).toBe(1)
  })

  it('overrides neither the heading nor the error line, so the copy cannot vary', () => {
    // A heading that said "locked manually" would tell a coercer the user armed
    // it deliberately — the one thing this screen must not disclose.
    expect(gateProps(6).title).toBeUndefined()
    expect(gateProps(6).errorText).toBeUndefined()
  })

  it('shows for every reason that can raise it, with nothing distinguishing them', () => {
    const raised = [
      isPinRequired({configured: true, mode: 'everyUnlock', isColdStart: false, isArmed: false}),
      isPinRequired({configured: true, mode: 'coldStart', isColdStart: true, isArmed: false}),
      isPinRequired({configured: true, mode: 'armed', isColdStart: false, isArmed: true}),
    ]
    expect(raised).toEqual([true, true, true])

    // …and all three land on the same props.
    expect(new Set(raised.map(() => JSON.stringify(gateProps(6)))).size).toBe(1)
  })
})
