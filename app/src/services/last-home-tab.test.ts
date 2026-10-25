import {describe, expect, it} from 'vitest'

import {HOME_TABS, homeTabHref, parseHomeTab} from './last-home-tab'

describe('parseHomeTab', () => {
  it('accepts the three home tabs', () => {
    for (const tab of HOME_TABS) expect(parseHomeTab(tab)).toBe(tab)
  })

  it('reads absent as no tab rather than inventing one', () => {
    expect(parseHomeTab(null)).toBeNull()
    expect(parseHomeTab(undefined)).toBeNull()
    expect(parseHomeTab('')).toBeNull()
  })

  it('refuses menu, which is a settings surface and not a home', () => {
    // Landing someone in Menu after an unlock is worse than any fixed default.
    expect(parseHomeTab('menu')).toBeNull()
  })

  it('refuses a value from a renamed or unknown route', () => {
    for (const bad of ['card', 'home', 'Wallets', '/wallets', 'wallets ']) expect(parseHomeTab(bad)).toBeNull()
  })
})

describe('homeTabHref', () => {
  it('maps each tab onto its route', () => {
    expect(homeTabHref('id')).toBe('/id')
    expect(homeTabHref('community')).toBe('/community')
    expect(homeTabHref('wallets')).toBe('/wallets')
  })
})
