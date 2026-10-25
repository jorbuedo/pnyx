import {describe, expect, it} from 'vitest'
import {needsManualDispatch} from './deep-link-dispatch'

describe('needsManualDispatch', () => {
  it('keeps versioned partner brand links in the manual QR action pipeline', () => {
    expect(needsManualDispatch('pnyx://pnyx.pxkq.uk/w1/transfer/request/ada-with-link?link=x', 'pnyx')).toBe(true)
    expect(needsManualDispatch('pnyx://pnyx.pxkq.uk/w1/transfer/request/crypto?chain=eip155%3A1', 'pnyx')).toBe(true)
  })
})
