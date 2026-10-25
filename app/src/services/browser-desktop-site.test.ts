import {describe, expect, it} from 'vitest'
import {
  DESKTOP_USER_AGENT,
  DESKTOP_VIEWPORT_SCRIPT,
  DESKTOP_VIEWPORT_WIDTH,
  desktopSiteInjection,
} from './browser-desktop-site'

describe('desktopSiteInjection', () => {
  it('supplies both halves when on — a UA switch alone leaves CSS-gated dApps unchanged', () => {
    const {userAgent, script} = desktopSiteInjection(true)
    expect(userAgent).toBe(DESKTOP_USER_AGENT)
    expect(script).toBe(DESKTOP_VIEWPORT_SCRIPT)
  })

  // Not a mobile UA of our own: the WebView's own string is the honest one, and a second invented
  // string is how the two drift apart.
  it('leaves the platform default when off', () => {
    expect(desktopSiteInjection(false)).toEqual({userAgent: undefined, script: undefined})
  })
})

describe('DESKTOP_USER_AGENT', () => {
  it('claims a desktop platform and no mobile marker', () => {
    expect(DESKTOP_USER_AGENT).toContain('Macintosh')
    expect(DESKTOP_USER_AGENT).not.toMatch(/Mobile|Android|iPhone/)
  })
})

describe('DESKTOP_VIEWPORT_SCRIPT', () => {
  it('claims the configured width', () => {
    expect(DESKTOP_VIEWPORT_SCRIPT).toContain(`var WIDTH = ${DESKTOP_VIEWPORT_WIDTH}`)
    expect(DESKTOP_VIEWPORT_WIDTH).toBeGreaterThanOrEqual(1024)
  })

  // The page's own meta is authoritative, so ours has to win — including when an SPA installs one on
  // a later route change, which is why the observer is here at all.
  it('removes competing viewport metas and re-asserts on later mutations', () => {
    expect(DESKTOP_VIEWPORT_SCRIPT).toContain('meta[name="viewport"]')
    expect(DESKTOP_VIEWPORT_SCRIPT).toContain('removeChild')
    expect(DESKTOP_VIEWPORT_SCRIPT).toContain('MutationObserver')
  })

  // Ours is tagged so the observer can tell it from the page's; without that marker it would delete
  // its own meta and re-add it forever.
  it('marks its own meta so it does not fight itself', () => {
    expect(DESKTOP_VIEWPORT_SCRIPT).toContain('data-pnyx-desktop')
  })

  // Injected scripts must end in a statement whose value is not an object, or the bridge treats the
  // result as a message on iOS.
  it('ends with a harmless truthy value', () => {
    expect(DESKTOP_VIEWPORT_SCRIPT.trimEnd().endsWith('true;')).toBe(true)
  })
})
