import type {ReviewedTransaction} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import {
  clearPendingActivity,
  dropPendingActivity,
  onPendingActivityChange,
  type PendingActivity,
  registerPendingActivity,
  resolvePendingActivity,
  visiblePendingActivity,
} from './pending-activity'
import type {CardanoRail} from './rail'

const reviewed = {chain: 'cardano'} as unknown as ReviewedTransaction
const entry = (hash: string, submittedAt: number): PendingActivity => ({hash, submittedAt, reviewed})

describe('visiblePendingActivity', () => {
  it('shows a just-submitted transaction the store has not seen', () => {
    const out = visiblePendingActivity([entry('a', 1_000)], new Set(), 2_000)
    expect(out.map((e) => e.hash)).toEqual(['a'])
  })

  it('drops an entry once the indexed row exists — never both', () => {
    // The overlay must not duplicate the row, and must not have to promote itself
    // to confirmed: the indexed producer owns that claim.
    const out = visiblePendingActivity([entry('a', 1_000)], new Set(['a']), 2_000)
    expect(out).toEqual([])
  })

  it('drops an entry that never confirmed within the tracker window', () => {
    // Matches PendingTxTracker's sweep: a transaction whose UTxO lock has been
    // released must not still be shown as pending.
    const out = visiblePendingActivity([entry('a', 1_000)], new Set(), 1_000 + 2 * 3600_000, 2 * 3600_000)
    expect(out).toEqual([])
  })

  it('keeps an entry right up to the window edge', () => {
    const out = visiblePendingActivity([entry('a', 1_000)], new Set(), 1_000 + 2 * 3600_000 - 1, 2 * 3600_000)
    expect(out.map((e) => e.hash)).toEqual(['a'])
  })

  it('orders newest-first so the latest send leads the section', () => {
    const out = visiblePendingActivity([entry('old', 1_000), entry('new', 5_000)], new Set(), 6_000)
    expect(out.map((e) => e.hash)).toEqual(['new', 'old'])
  })

  it('does not mutate its input', () => {
    const input = [entry('old', 1_000), entry('new', 5_000)]
    visiblePendingActivity(input, new Set(), 6_000)
    expect(input.map((e) => e.hash)).toEqual(['old', 'new'])
  })
})

describe('change notification', () => {
  // A list already on screen has no other way to learn about a transaction
  // submitted after it mounted: the reading hook stops polling once its initial
  // sync resolves. Reported from a real combine, where the pending row appeared on
  // the freshly-opened Activity screen but never on the wallet-home widget.
  const rail = {dataRef: {groupId: 'g', chainId: 'cardano:mainnet', accountIndex: 0}} as unknown as CardanoRail

  it('notifies on register, so a mounted list can re-read', () => {
    let calls = 0
    const off = onPendingActivityChange(() => calls++)

    registerPendingActivity(rail, 'aa', reviewed, 1_000)
    expect(calls).toBe(1)

    off()
    registerPendingActivity(rail, 'bb', reviewed, 1_000)
    expect(calls).toBe(1)
    clearPendingActivity()
  })

  it('notifies on clear, so a network switch empties the overlay everywhere', () => {
    let calls = 0
    const off = onPendingActivityChange(() => calls++)
    clearPendingActivity()
    expect(calls).toBe(1)
    off()
  })

  it('stays silent when a drop removed nothing', () => {
    // A no-op must not wake every list in the app.
    let calls = 0
    const off = onPendingActivityChange(() => calls++)
    dropPendingActivity(rail, 'never-registered')
    expect(calls).toBe(0)
    off()
  })
})

describe('resolvePendingActivity', () => {
  const rail = {dataRef: {groupId: 'g', chainId: 'cardano:mainnet', accountIndex: 0}} as unknown as CardanoRail
  const other = {dataRef: {groupId: 'h', chainId: 'cardano:mainnet', accountIndex: 0}} as unknown as CardanoRail

  // ⚠️ The defect this exists for. `visiblePendingActivity` already drops an entry the store has,
  // but a list only re-applies that when it re-reads — and nothing told an already-mounted list the
  // store had gained rows. The Activity screen cleared on focus while the home widget kept spinning
  // on a confirmed transaction until the timeout swept it.
  it('notifies once when the walk stores a hash the overlay was waiting on', () => {
    clearPendingActivity()
    registerPendingActivity(rail, 'aa', reviewed, 1_000)
    registerPendingActivity(rail, 'bb', reviewed, 1_000)
    let calls = 0
    const off = onPendingActivityChange(() => calls++)

    resolvePendingActivity(rail, ['aa', 'bb'])
    expect(calls).toBe(1)
    expect(visiblePendingActivity([entry('aa', 1_000)], new Set(), 2_000).length).toBe(1)
    off()
    clearPendingActivity()
  })

  it('says nothing when none of the stored hashes was pending', () => {
    clearPendingActivity()
    registerPendingActivity(rail, 'aa', reviewed, 1_000)
    let calls = 0
    const off = onPendingActivityChange(() => calls++)

    // The walk persists hundreds of rows per window on a backfill; a notification per row would
    // re-read every mounted list for transactions nobody is waiting on.
    resolvePendingActivity(rail, ['cc', 'dd'])
    expect(calls).toBe(0)
    off()
    clearPendingActivity()
  })

  // Keyed by rail: one wallet's confirmation must not clear another's pending row.
  it('leaves another wallet’s entry alone', () => {
    clearPendingActivity()
    registerPendingActivity(rail, 'aa', reviewed, 1_000)
    let calls = 0
    const off = onPendingActivityChange(() => calls++)

    resolvePendingActivity(other, ['aa'])
    expect(calls).toBe(0)
    off()
    clearPendingActivity()
  })
})
