/**
 * Types and icon resolution for the Browser discover list.
 *
 * The list is remote-config driven: `dapps.recommended` on config.pxkq.uk →
 * `<env>.json` is the only source of entries — see docs/remote-config.md to
 * add/edit them (no app release needed).
 *
 * There is deliberately no built-in fallback list. A hardcoded tile outlives
 * whatever it pointed at: when the remote list is unreachable it would keep
 * promoting a dApp that may have moved, been retired, or been pulled on
 * purpose. Showing no tiles is the honest failure mode, and `BrowserStartPage`
 * renders just the hint copy when the list is empty.
 *
 * @module
 */

import type {RemoteDappConfig} from '@pnyx/config'

export type DiscoverDapp = {
  /**
   * Stable id from the remote entry, and the key a favourite is remembered by.
   *
   * ⚠️ Not the URL: a dApp that moves domain would silently lose its star, and two entries sharing a
   * host would share one.
   */
  readonly id: string
  /** Display name shown on the row. */
  readonly name: string
  /** URL loaded in the active tab when the row is tapped. */
  readonly url: string
  /** Explicit icon URL (the remote `logo`). Must be a raster format — RN's core
   * <Image> can't decode `.ico`/`.svg`; use `.png`. Absent → no icon is rendered. */
  readonly logo?: string
  /**
   * What the dApp is for, shown under its name.
   *
   * A list because the row renders one label per entry; the remote currently sends a single
   * `category`, so this is that one wrapped — no string is split on a separator the config never
   * promised.
   */
  readonly categories: readonly string[]
}

/** No offline fallback by design — see the module doc. */
export const DEFAULT_DISCOVER_DAPPS: readonly DiscoverDapp[] = []

/**
 * The discover tiles to render for a remote `dapps` block: the recommended
 * entries mapped to tiles, or nothing at all when the block is missing, has no
 * `recommended` array, or that array is empty.
 */
export const discoverDappsFrom = (dapps: RemoteDappConfig | undefined): readonly DiscoverDapp[] => {
  const recommended = dapps?.recommended
  if (!recommended || recommended.length === 0) return DEFAULT_DISCOVER_DAPPS
  return recommended.map((d) => ({
    id: d.id,
    name: d.name,
    url: d.uri,
    ...(d.logo ? {logo: d.logo} : {}),
    categories: d.category ? [d.category] : [],
  }))
}

/**
 * Icon URL for a discover tile: the remote `logo`, or `null` so the caller renders no icon.
 *
 * There is deliberately no favicon fallback. It used to resolve to Google's public favicon
 * service, which meant opening the browser start page told Google which dApps we promote and
 * which of them a user sees — a third-party call on a privacy surface, for decoration. It also
 * broke the Third-Party API policy, which the curated-list work (`docs/mobile-shell-plan.md`
 * Phase 11 item 31) had already flagged as a fix owed.
 *
 * The consequence is intended: an entry with no `logo` shows an empty icon slot, so a curated
 * entry without first-party artwork looks unfinished. Publish a `logo` for every entry.
 */
export const discoverIconUri = (dapp: DiscoverDapp): string | null => dapp.logo ?? null
