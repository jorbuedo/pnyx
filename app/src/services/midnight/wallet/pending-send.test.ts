import {describe, expect, it} from 'vitest'

import type {MidnightActivity} from './midnight-activity'
import {
  PENDING_SEND_TTL_MS,
  type PendingSend,
  pendingSendAsActivity,
  resolvePendingSends,
  visiblePendingSends,
} from './pending-send'

const NOW = Date.parse('2026-08-21T12:00:00.000Z')

const send = (
  identifiers: readonly string[],
  submittedAt = '2026-08-21T11:59:00.000Z',
  direction: PendingSend['direction'] = 'sent',
): PendingSend => ({
  identifiers,
  rail: 'unshielded',
  direction,
  tokenType: '00'.repeat(32),
  amount: 1_000_000n,
  recipient: 'mn_addr_someone',
  submittedAt,
})

const row = (identifiers: readonly string[], hash = 'landed'): MidnightActivity => ({
  transactionId: 1,
  hash,
  direction: 'sent',
  netByToken: new Map(),
  tokens: new Set(),
  ourSpentCount: 1,
  ourCreatedCount: 1,
  counterparties: [],
  identifiers,
})

describe('resolvePendingSends', () => {
  it('resolves a send against the row that carries its identifier', () => {
    // The landed row also carries the sponsor's own identifiers — this is the real shape.
    const result = resolvePendingSends([send(['aa'])], [row(['aa', 'sponsor-bb'])], NOW)

    expect(result.resolved).toHaveLength(1)
    expect(result.resolved[0]?.row.hash).toBe('landed')
    expect(result.stillPending).toEqual([])
    expect(result.abandoned).toEqual([])
  })

  it('keeps a recent send pending when no row matches yet', () => {
    const result = resolvePendingSends([send(['aa'])], [row(['unrelated'])], NOW)

    expect(result.stillPending).toHaveLength(1)
    expect(result.resolved).toEqual([])
    expect(result.abandoned).toEqual([])
  })

  it('abandons a send past twice its TTL, because a node rejection leaves no row to find', () => {
    const old = new Date(NOW - PENDING_SEND_TTL_MS - 1).toISOString()

    const result = resolvePendingSends([send(['aa'], old)], [], NOW)

    expect(result.abandoned).toHaveLength(1)
    expect(result.stillPending).toEqual([])
  })

  it('resolves an old send that did land, rather than abandoning it on age alone', () => {
    const old = new Date(NOW - PENDING_SEND_TTL_MS - 1).toISOString()

    const result = resolvePendingSends([send(['aa'], old)], [row(['aa'])], NOW)

    expect(result.resolved).toHaveLength(1)
    expect(result.abandoned).toEqual([])
  })

  it('abandons a send whose timestamp cannot be read instead of holding it for ever', () => {
    // Every comparison against NaN is false, so the naive form would keep this pending permanently.
    const result = resolvePendingSends([send(['aa'], 'not-a-date')], [], NOW)

    expect(result.abandoned).toHaveLength(1)
    expect(result.stillPending).toEqual([])
  })

  it('preserves order and handles several sends at once', () => {
    const a = send(['aa'])
    const b = send(['bb'])
    const c = send(['cc'])

    const result = resolvePendingSends([a, b, c], [row(['bb'])], NOW)

    expect(result.resolved.map((r) => r.send.identifiers)).toEqual([['bb']])
    expect(result.stillPending.map((s) => s.identifiers)).toEqual([['aa'], ['cc']])
  })

  it('does not resolve anything when there are no rows', () => {
    expect(resolvePendingSends([send(['aa'])], [], NOW).resolved).toEqual([])
  })
})

describe('pendingSendAsActivity', () => {
  it('renders as an in-flight row: no timestamp, marked pending, amount negative', () => {
    const row = pendingSendAsActivity(send(['aa11']))

    // The row component keys its spinner off an absent timestamp, so this is what makes it in-flight.
    expect(row.timestamp).toBeUndefined()
    expect(row.pending).toBe(true)
    expect(row.direction).toBe('sent')
    expect(row.netByToken.get('00'.repeat(32))).toBe(-1_000_000n)
  })

  it('records token participation, so a self-send does not vanish from its own token list', () => {
    expect(pendingSendAsActivity(send(['aa11'])).tokens.has('00'.repeat(32))).toBe(true)
  })

  it('carries the identifier as the row hash, since a pre-binding transaction has none', () => {
    expect(pendingSendAsActivity(send(['aa11', 'bb22'])).hash).toBe('aa11')
  })

  it('names the recipient as the counterparty', () => {
    expect(pendingSendAsActivity(send(['aa11'])).counterparties).toEqual(['mn_addr_someone'])
  })
})

describe('visiblePendingSends', () => {
  it('shows a send the stored rows do not yet contain', () => {
    expect(visiblePendingSends([send(['aa'])], [row(['other'])], NOW)).toHaveLength(1)
  })

  it('drops a send the moment an indexed row contains its identifier', () => {
    // The stored row wins, so the list never shows the same transaction twice.
    expect(visiblePendingSends([send(['aa'])], [row(['aa', 'sponsor-bb'])], NOW)).toEqual([])
  })

  it('drops an abandoned send rather than showing it in flight for ever', () => {
    const old = new Date(NOW - PENDING_SEND_TTL_MS - 1).toISOString()

    expect(visiblePendingSends([send(['aa'], old)], [], NOW)).toEqual([])
  })

  it('orders newest first', () => {
    const older = send(['aa'], '2026-08-21T11:00:00.000Z')
    const newer = send(['bb'], '2026-08-21T11:58:00.000Z')

    expect(visiblePendingSends([older, newer], [], NOW).map((r) => r.hash)).toEqual(['bb', 'aa'])
  })
})

describe('pendingSendAsActivity — a self-send is shaped like the row that replaces it', () => {
  it('labels a self-send `self`, not `sent`', () => {
    // Hardcoding 'sent' read "Sent" for the whole pending window and then relabelled itself
    // "Internal" once the chain accounted for it. Reported from a real device run.
    expect(pendingSendAsActivity(send(['aa'], undefined, 'self')).direction).toBe('self')
  })

  it('gives a self-send no amount, because its net cancels exactly', () => {
    // The landed row shows none: created and spent amounts cancel and `signedNet` drops a zero entry.
    // Showing `-3.75` here would change the moment it landed.
    expect(pendingSendAsActivity(send(['aa'], undefined, 'self')).netByToken.size).toBe(0)
  })

  it('still records token participation for a self-send, so it stays in its own token list', () => {
    expect(pendingSendAsActivity(send(['aa'], undefined, 'self')).tokens.has('00'.repeat(32))).toBe(true)
  })

  it('a send to someone else still nets negative', () => {
    expect(pendingSendAsActivity(send(['aa'], undefined, 'sent')).netByToken.get('00'.repeat(32))).toBe(-1_000_000n)
  })
})
