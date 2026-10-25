/**
 * Contract tests for the v2 empty-state copy keys.
 *
 * These keys are referenced by the BuyPromoCard / DashboardEmptyContent /
 * PortfolioEmptyContent / ActivityEmptyContent surfaces. A rename or stray
 * fallback edit on the English source would silently change every empty
 * state across Home, Portfolio, and Activity — the translation pipeline then carries the
 * regression to every other locale on the next sync. Lock the copy here so
 * a copy revert needs an explicit test edit.
 *
 * @module
 */

import {describe, expect, it} from 'vitest'
import {translations} from './translations'

describe('translations.dashboard.empty.promo*', () => {
  it('uses the v2 "Get started now / Fund your account / Add funds" copy', () => {
    expect(translations.dashboard.empty.promoEyebrow).toBe('Get started now')
    expect(translations.dashboard.empty.promoTitle).toBe('Fund your account')
    expect(translations.dashboard.empty.promoCta).toBe('Add funds')
  })

  it('does not expose a `promoSub` key — the v2 promo card has no sub line', () => {
    // The previous "Buy your first crypto" promo had a `promoSub` rendered
    // below the title. The v2 promo card is title-only — re-introducing
    // the key would re-introduce a UI element that's no longer in the spec.
    expect((translations.dashboard.empty as Record<string, unknown>).promoSub).toBeUndefined()
  })
})

describe('translations.transactions — Activity empty state', () => {
  it('exposes the heartbeat-card copy used by ActivityEmptyContent', () => {
    expect(translations.transactions.noActivityYet).toBe('No activity yet')
    expect(translations.transactions.noActivityYetSub).toBe(
      'Once you get started, every send, swap, stake, and reward will appear in this feed.',
    )
  })
})

describe('translations.portfolio.emptyState', () => {
  it('uses the v2 "Start your portfolio" copy with the funds-oriented sub', () => {
    expect(translations.portfolio.emptyState.title).toBe('Start your portfolio')
    expect(translations.portfolio.emptyState.sub).toBe(
      'Fund your wallet to watch your balance, transactions, and earnings grow here.',
    )
  })
})
