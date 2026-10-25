import {describe, expect, it} from 'vitest'
import {resolveTokenIconOverride} from './token-icon-override'

const NIGHT_POLICY_ID = '0691b2fecca1ac4f53cb6dfb00b7013e561d1f34403b957cbb5af1fa'
const NIGHT_ID = `${NIGHT_POLICY_ID}.4e49474854`
const OTHER_ID = `${'a'.repeat(56)}.deadbeef`

describe('resolveTokenIconOverride', () => {
  it('returns a NIGHT glyph for the NIGHT asset', () => {
    expect(resolveTokenIconOverride(NIGHT_ID, false)).not.toBeNull()
    expect(resolveTokenIconOverride(NIGHT_ID, true)).not.toBeNull()
  })

  it('swaps the glyph by theme (light vs dark differ)', () => {
    const light = resolveTokenIconOverride(NIGHT_ID, false)
    const dark = resolveTokenIconOverride(NIGHT_ID, true)
    expect(light).not.toEqual(dark)
  })

  it('returns null for any other token', () => {
    expect(resolveTokenIconOverride(OTHER_ID, true)).toBeNull()
    expect(resolveTokenIconOverride(OTHER_ID, false)).toBeNull()
  })

  it('returns null for ADA / empty id', () => {
    expect(resolveTokenIconOverride('', true)).toBeNull()
  })
})
