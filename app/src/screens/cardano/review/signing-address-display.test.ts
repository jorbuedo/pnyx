import {describe, expect, it} from 'vitest'
import {signingAddressDisplay} from './signing-address-display'

describe('the address a signature asserts', () => {
  /**
   * The wallet that proved a circle requirement on 2026-09-11. Its reward address is what the
   * service sends to Koios and what an explorer shows its owner, so it is the pair worth pinning.
   */
  it('renders a reward address as the stake1 form its owner can compare', () => {
    expect(signingAddressDisplay('e1766672051bd99de74c1dc72b17dfd3d12256a6416bbbb518e579d4d5')).toBe(
      'stake1u9mxvus9r0veme6vrhrjk97l60gjy44xg94mhdgcu4uaf4g04vcyc',
    )
  })

  // The same wallet's base address — the pair a person sees in their own Receive screen.
  it('renders a base address as addr1', () => {
    expect(
      signingAddressDisplay(
        '018b95dee62aefe7c007b88b4cb674c6b1ce1b2776101a60ba9d009b64766672051bd99de74c1dc72b17dfd3d12256a6416bbbb518e579d4d5',
      ),
    ).toBe('addr1qx9ethhx9th70sq8hz95edn5c6cuuxe8wcgp5c96n5qfkerkveeq2x7enhn5c8w89vtal573yft2vstthw633ete6n2stnvmtx')
  })

  // ⚠️ Shown, not swallowed: the user is still being asked to sign with it, and a blank field on a
  // consent surface is worse than an unreadable one.
  it('falls back to the raw bytes when they are not an address', () => {
    expect(signingAddressDisplay('not-hex-at-all')).toBe('not-hex-at-all')
    expect(signingAddressDisplay('e1ff')).toBe('e1ff')
  })
})
