import {describe, expect, it} from 'vitest'
import {hasActiveDot} from './matching'
import {TAB_NOTICE_ROUTES} from './nav-routes'
import type {NoticeKey, NoticeValue} from './notice-context-core'

const notices = (...entries: [string, NoticeValue][]): ReadonlyMap<NoticeKey, NoticeValue> => new Map(entries)

describe('tab notice routes', () => {
  it('lights the Menu tab from a notice under /settings', () => {
    // The regression this exists for: every source anchors under /settings, and the tab that leads
    // there is /menu — so with a single prefix the trail of dots started at its own destination.
    const active = notices(['security-settings-unseen', {route: '/settings/security', active: true}])
    expect(hasActiveDot(active, new Map(), TAB_NOTICE_ROUTES.menu)).toBe(true)
    expect(hasActiveDot(active, new Map(), TAB_NOTICE_ROUTES.community)).toBe(false)
    expect(hasActiveDot(active, new Map(), TAB_NOTICE_ROUTES.wallets)).toBe(false)
  })

  it('lights the Community tab from a DM thread, which lives at a top-level route', () => {
    const active = notices(['dm-unread:abc', {route: '/dm/abc', active: true}])
    expect(hasActiveDot(active, new Map(), TAB_NOTICE_ROUTES.community)).toBe(true)
    expect(hasActiveDot(active, new Map(), TAB_NOTICE_ROUTES.menu)).toBe(false)
  })

  it('still matches a segment boundary, so a sibling route does not leak across tabs', () => {
    const active = notices(['x', {route: '/settingsomething', active: true}])
    expect(hasActiveDot(active, new Map(), TAB_NOTICE_ROUTES.menu)).toBe(false)
  })

  it('an inactive or dismissed notice lights nothing, through several routes as through one', () => {
    expect(
      hasActiveDot(notices(['x', {route: '/settings/security', active: false}]), new Map(), TAB_NOTICE_ROUTES.menu),
    ).toBe(false)
    expect(
      hasActiveDot(
        notices(['x', {route: '/settings/security', active: true, dismissable: true}]),
        new Map([['x', '']]),
        TAB_NOTICE_ROUTES.menu,
      ),
    ).toBe(false)
  })

  it('lights Wallets, not Menu, for a pending backup — the gear on Wallets is the only way in', () => {
    // The lingering dot: `/settings` on the Menu tab swallowed `/settings/wallet-settings`, which
    // the Menu does not list and cannot reach. The dot sat on the one tab with nothing behind it
    // while the tab that leads there stayed dark, and `backup-pending` is not dismissable, so it
    // stayed until the phrase was verified.
    const active = notices(['backup-pending', {route: '/settings/wallet-settings', active: true}])
    expect(hasActiveDot(active, new Map(), TAB_NOTICE_ROUTES.wallets)).toBe(true)
    expect(hasActiveDot(active, new Map(), TAB_NOTICE_ROUTES.menu)).toBe(false)
  })

  it('subtracts only the named subtree, leaving the rest of /settings on Menu', () => {
    const active = notices(['push-permission-missing', {route: '/settings/notifications', active: true}])
    expect(hasActiveDot(active, new Map(), TAB_NOTICE_ROUTES.menu)).toBe(true)
    expect(hasActiveDot(active, new Map(), TAB_NOTICE_ROUTES.wallets)).toBe(false)
  })

  it('an exclusion with no matching include lights nothing rather than everything', () => {
    const active = notices(['x', {route: '/settings/wallet-settings', active: true}])
    expect(hasActiveDot(active, new Map(), ['!/settings'])).toBe(false)
  })

  it('takes a bare string as before, so existing single-route callers are unchanged', () => {
    const active = notices(['x', {route: '/settings/security', active: true}])
    expect(hasActiveDot(active, new Map(), '/settings')).toBe(true)
    expect(hasActiveDot(active, new Map(), '/menu')).toBe(false)
  })
})
