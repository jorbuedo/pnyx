import {readdirSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import {describe, expect, it} from 'vitest'

import {translations} from '../i18n/translations'
import {DEV_TOOLS_ROWS, type DevToolsRow} from './dev-tools-rows'

/**
 * The English text a row shows.
 *
 * Resolves a translation key against the EN source rather than comparing keys: the keychain probe is
 * localized into eleven languages while the other probes are dev-only literals, so sorting the raw
 * `label` field would order "settings.developer.keychainProbe" against "MLS on Hermes probe".
 */
const shownLabel = (row: DevToolsRow): string => {
  if (row.text.kind === 'text') return row.text.label
  const resolved = row.text.label
    .split('.')
    .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], translations)
  if (typeof resolved !== 'string') throw new Error(`${row.text.label} is not a string in the EN translations`)
  return resolved
}

const DEV_DIR = join(__dirname, '../../app/settings/dev')
const LAYOUT = join(__dirname, '../../app/settings/_layout.tsx')

/** Every screen that exists under `app/settings/dev/`, by route name. */
const screensOnDisk = (): readonly string[] =>
  readdirSync(DEV_DIR)
    .filter((file) => file.endsWith('.tsx'))
    .map((file) => file.replace(/\.tsx$/, ''))
    .sort()

/** The routes the menu offers, restricted to the ones under `settings/dev/`. */
const routesInMenu = (): readonly string[] =>
  DEV_TOOLS_ROWS.map((row) => row.route)
    .filter((route) => route.startsWith('/settings/dev/'))
    .map((route) => route.replace('/settings/dev/', ''))
    .sort()

describe('the Developer menu offers every dev screen', () => {
  it('has a row for each screen on disk', () => {
    // The failure this prevents: a probe is written, works, and is reachable only by deep link — which
    // is how `dust-probe` shipped invisible to anyone who did not already know the path.
    expect(routesInMenu()).toEqual(screensOnDisk())
  })

  it('registers each screen in the settings layout, so it gets a title', () => {
    // Without a `Stack.Screen` the header shows the raw pathname. `dev/tx-lookup` shipped that way.
    const layout = readFileSync(LAYOUT, 'utf8')
    for (const screen of screensOnDisk()) {
      expect(layout, `dev/${screen} needs a Stack.Screen in settings/_layout.tsx`).toContain(`name="dev/${screen}"`)
    }
  })

  it('registers no screen that does not exist, so no route warns at mount', () => {
    // The other direction, and the one that shipped broken: `dev/mcp-pairing` stayed in the layout
    // after the pairing UI moved to `settings/agents`, so every mount logged
    // `No route named "dev/mcp-pairing"`.
    const layout = readFileSync(LAYOUT, 'utf8')
    const registered = [...layout.matchAll(/name="dev\/([^"]+)"/g)].map((match) => match[1] as string).sort()
    expect(registered).toEqual(screensOnDisk())
  })

  it('gives every row a unique route and testID', () => {
    const routes = DEV_TOOLS_ROWS.map((row) => row.route)
    const testIDs = DEV_TOOLS_ROWS.map((row) => row.testID)
    expect(new Set(routes).size).toBe(routes.length)
    expect(new Set(testIDs).size).toBe(testIDs.length)
  })
})

describe('the order', () => {
  it('puts every tool before every probe', () => {
    // The point of the grouping: nine probes ahead of the log would bury what is used daily.
    const kinds = DEV_TOOLS_ROWS.map((row) => row.kind)
    expect(kinds.indexOf('probe')).toBeGreaterThan(kinds.lastIndexOf('tool'))
  })

  it('starts with flags and logs', () => {
    expect(DEV_TOOLS_ROWS[0]?.route).toBe('/settings/dev/feature-flags')
    expect(DEV_TOOLS_ROWS[1]?.route).toBe('/settings/dev/logs')
  })

  it('lists probes alphabetically by the label a person reads', () => {
    // By label, not by route: sorting by filename put "Unicode NFC probe" between the two
    // "On-device …" entries, which looks unsorted to anyone scanning the screen.
    const labels = DEV_TOOLS_ROWS.filter((row) => row.kind === 'probe').map(shownLabel)
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)))
  })

  it('resolves every row label to real English, so a stale key cannot ship blank', () => {
    for (const row of DEV_TOOLS_ROWS) expect(shownLabel(row).length, row.route).toBeGreaterThan(0)
  })

  it('classifies every probe screen as a probe', () => {
    // A screen named `*-probe` that is marked `tool` would sort into the wrong half and defeat the
    // grouping without failing anything else.
    for (const row of DEV_TOOLS_ROWS) {
      if (row.route.endsWith('-probe')) expect(row.kind, row.route).toBe('probe')
    }
  })

  it('classifies nothing else as a probe', () => {
    for (const row of DEV_TOOLS_ROWS) {
      if (row.kind === 'probe') expect(row.route, row.route).toMatch(/-probe$/)
    }
  })
})
