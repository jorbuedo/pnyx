/**
 * How a name length is presented: what its ticket is called, and whether it is shown at all.
 *
 * The contract knows tiers as 0..6. A user should not have to: a tier is a thing you hold, so it gets
 * a name. The ladder runs most-scarce first, because that is the order scarcity runs in — tier 0 is
 * the one- and two-character names.
 *
 * ⚠️ **The two shortest lengths are not advertised.** They are shown only to somebody already holding
 * a ticket for them (product decision, 2026-08-30). Hiding them is presentation, never enforcement —
 * `bind` accepts exactly the name's own tier whatever this module says, so nothing here can grant or
 * deny a claim.
 *
 * @module
 */

import {hexFromOklch, oklchFromHex} from '../theme/oklch'
import type {TierRange} from './handle-tier-ranges'

/** The i18n key under `you.handle.screen.tierName` for each tier. */
export const TIER_NAME_KEY: Readonly<Record<number, string>> = {
  0: 'obsidian',
  1: 'diamond',
  2: 'platinum',
  3: 'gold',
  4: 'silver',
  5: 'bronze',
  6: 'standard',
}

/**
 * A dot colour per ticket, so the ladder reads at a glance.
 *
 * Hex rather than theme tokens because this is **data**: the accent belongs to the tier the way a
 * token's brand colour belongs to the token, and there is no light/dark variant of "bronze". Mid-tones
 * throughout, so each stays legible on either theme's surface.
 */
export const TIER_ACCENT: Readonly<Record<number, string>> = {
  0: '#7C3AED',
  1: '#22D3EE',
  // ⚠️ Platinum, silver and standard are all "grey" as materials, and three greys in a column read as
  // one. Platinum takes a cool indigo cast and standard a green — the ladder has to be scannable, and
  // a literal metal colour that nobody can tell apart is not more faithful, only less useful.
  2: '#818CF8',
  3: '#D4A017',
  4: '#94A3B8',
  5: '#B45309',
  6: '#10B981',
}

/** The lengths that are never advertised — shown only to a holder. */
export const isSecretTier = (tier: number): boolean => tier === 0 || tier === 1

/**
 * The tiers to render, in ladder order.
 *
 * A secret tier appears only when `heldByTier` says this device holds a ticket for it. `undefined`
 * holdings mean "we have not looked", which is **not** a reason to reveal one — a screen that showed
 * every length while a wallet was still syncing would advertise them by accident.
 */
export const visibleTiers = (
  ranges: readonly TierRange[],
  heldByTier: ReadonlyMap<number, bigint> | undefined,
): readonly TierRange[] =>
  ranges.filter((range) => !isSecretTier(range.tier) || (heldByTier?.get(range.tier) ?? 0n) > 0n)

/**
 * A ticket drawn as a struck coin: the two stops its face is filled with, and the shade its mark is
 * stamped in.
 *
 * Derived from the accent rather than listed beside it, so a tier cannot end up carrying a colour and
 * three shades that disagree with it. OkLCh, because the same lightness step in HSL lands differently
 * per hue — gold would glare where bronze went flat, and the ladder has to read as one metal.
 */
export type TierCoinFace = {
  /** Face gradient, light stop first. */
  readonly fill: readonly [string, string]
  /** The mark, struck darker than the field it sits in. */
  readonly stamp: string
  /**
   * The light caught on the lower lip of the struck mark.
   *
   * A letterpress highlight, drawn a pixel below the mark: a debossed shape is read from the shadow on
   * the side the light comes from and the glint on the far side, and without the glint a dark mark on
   * a coloured field is just a printed one.
   */
  readonly glint: string
}

const shade = (accent: string, lighten: number, saturate: number): string => {
  const {l, c, h} = oklchFromHex(accent)

  return hexFromOklch({l: Math.min(0.97, Math.max(0.06, l + lighten)), c: c * saturate, h})
}

/**
 * Struck once at module load.
 *
 * ⚠️ The gradient is a tuple, and `ChamferPaint` is memoised on its props — a face rebuilt per render
 * would hand it a fresh array every time and rebuild every coin's SVG path on every keystroke in the
 * name field. The accents are constants, so there is nothing to recompute.
 */
export const TIER_COIN: Readonly<Record<number, TierCoinFace>> = Object.fromEntries(
  Object.entries(TIER_ACCENT).map(([tier, accent]) => [
    Number(tier),
    {
      fill: [shade(accent, 0.1, 0.9), shade(accent, -0.09, 1)],
      stamp: shade(accent, -0.3, 0.8),
      glint: shade(accent, 0.22, 0.7),
    } satisfies TierCoinFace,
  ]),
)
