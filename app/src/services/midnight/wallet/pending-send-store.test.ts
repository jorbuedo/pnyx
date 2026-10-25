import {describe, expect, it} from 'vitest'
import type {PendingSend} from './pending-send'
import {livePendingSends, PENDING_SEND_TTL_MS, parsePendingSends, pendingSendKey} from './pending-send-store'

const one = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 2,
    sends: [
      {
        identifiers: ['aa11'],
        rail: 'unshielded',
        direction: 'sent',
        tokenType: '00'.repeat(32),
        amount: '1000000',
        recipient: 'mn_addr_someone',
        submittedAt: '2026-08-21T11:00:00.000Z',
        ...over,
      },
    ],
  })

describe('pendingSendKey', () => {
  it('is scoped to the group and account', () => {
    expect(pendingSendKey('g1', 0)).toBe('@pnyx/midnight/pending-sends/g1/0')
  })
})

describe('parsePendingSends', () => {
  it('reads a stored send, with the amount as a bigint', () => {
    const [send] = parsePendingSends(one())

    expect(send?.amount).toBe(1_000_000n)
    expect(send?.identifiers).toEqual(['aa11'])
    expect(send?.rail).toBe('unshielded')
  })

  it('reads absent and empty as nothing pending', () => {
    expect(parsePendingSends(null)).toEqual([])
    expect(parsePendingSends('')).toEqual([])
  })

  it('treats an unreadable blob as nothing pending rather than throwing', () => {
    expect(parsePendingSends('{not json')).toEqual([])
    expect(parsePendingSends(JSON.stringify({version: 3, sends: []}))).toEqual([])
    expect(parsePendingSends(JSON.stringify({version: 2}))).toEqual([])
  })

  it('drops a send with no identifiers — it could never resolve', () => {
    expect(parsePendingSends(one({identifiers: []}))).toEqual([])
  })

  it('drops an amount that is not digits rather than reading it as zero', () => {
    expect(parsePendingSends(one({amount: '1.5'}))).toEqual([])
    expect(parsePendingSends(one({amount: 1_000_000}))).toEqual([])
  })

  it('drops an unknown rail rather than guessing one', () => {
    // The rail decides which builder produced it; guessing would mislabel the row.
    expect(parsePendingSends(one({rail: 'quantum'}))).toEqual([])
  })

  it('drops a send with no submission time, since the abandon window cannot be judged without it', () => {
    expect(parsePendingSends(one({submittedAt: 1_700_000_000}))).toEqual([])
  })

  it('keeps the readable sends when one row is bad', () => {
    const blob = JSON.stringify({
      version: 2,
      sends: [
        {
          identifiers: [],
          rail: 'unshielded',
          direction: 'sent',
          tokenType: 'aa',
          amount: '1',
          recipient: 'x',
          submittedAt: 'z',
        },
        {
          identifiers: ['bb'],
          rail: 'shielded',
          direction: 'self',
          tokenType: 'aa',
          amount: '2',
          recipient: 'y',
          submittedAt: 'z',
        },
      ],
    })

    expect(parsePendingSends(blob).map((s) => s.identifiers)).toEqual([['bb']])
  })
})

describe('parsePendingSends — direction', () => {
  it('reads the stored direction', () => {
    expect(parsePendingSends(one({direction: 'self'}))[0]?.direction).toBe('self')
  })

  it('drops a row with no readable direction rather than defaulting it to `sent`', () => {
    // Defaulting is the mislabelling the field exists to remove, so an unreadable row is dropped.
    expect(parsePendingSends(one({direction: undefined}))).toEqual([])
    expect(parsePendingSends(one({direction: 'sideways'}))).toEqual([])
  })

  it('discards a v1 blob, whose rows cannot say whether they were a self-send', () => {
    const v1 = JSON.stringify({
      version: 1,
      sends: [
        {identifiers: ['aa'], rail: 'unshielded', tokenType: 'aa', amount: '1', recipient: 'x', submittedAt: 'z'},
      ],
    })

    expect(parsePendingSends(v1)).toEqual([])
  })
})

/*
 * `removePendingSends` only fires when the chain accounts for the identifiers, so a transaction that
 * never lands has no other way out of this list. One that died at the sponsor showed "Pending" on the
 * wallets screen indefinitely — long after its one-hour input lock had lapsed and handed the balance
 * back, so the row claimed money was in flight while that money was spendable again. Observed on a
 * device, preprod, 2026-09-30.
 */
describe('livePendingSends', () => {
  const NOW = Date.parse('2026-09-30T18:00:00Z')
  const at = (iso: string): PendingSend => ({
    identifiers: ['aa11'],
    rail: 'unshielded',
    direction: 'sent',
    tokenType: 'night',
    amount: 1n,
    recipient: 'mn_addr_preprod1abc',
    submittedAt: iso,
  })

  it('keeps a send inside the window', () => {
    const {live, expired} = livePendingSends([at(new Date(NOW - 60_000).toISOString())], NOW)
    expect(live).toHaveLength(1)
    expect(expired).toHaveLength(0)
  })

  it('drops one that outlived it', () => {
    const old = at(new Date(NOW - PENDING_SEND_TTL_MS - 1000).toISOString())
    const {live, expired} = livePendingSends([old], NOW)
    expect(live).toHaveLength(0)
    expect(expired).toEqual([old])
  })

  it('is exclusive at the boundary, so a send is dropped only once past it', () => {
    const exactly = at(new Date(NOW - PENDING_SEND_TTL_MS).toISOString())
    expect(livePendingSends([exactly], NOW).expired).toHaveLength(1)
    const justInside = at(new Date(NOW - PENDING_SEND_TTL_MS + 1).toISOString())
    expect(livePendingSends([justInside], NOW).live).toHaveLength(1)
  })

  // Losing the record of money leaving is the one thing this store exists not to do, so an odd
  // timestamp is kept rather than used as grounds to discard the row.
  it('keeps a send whose timestamp cannot be parsed', () => {
    const {live, expired} = livePendingSends([at('not-a-date')], NOW)
    expect(live).toHaveLength(1)
    expect(expired).toHaveLength(0)
  })

  it('separates a mixed list rather than dropping the batch', () => {
    const fresh = at(new Date(NOW - 1000).toISOString())
    const stale = at(new Date(NOW - PENDING_SEND_TTL_MS - 1).toISOString())
    const {live, expired} = livePendingSends([fresh, stale], NOW)
    expect(live).toEqual([fresh])
    expect(expired).toEqual([stale])
  })

  // The window has to outlast the input lock, or a row could vanish while its inputs are still held.
  it('outlasts the one-hour input lock', () => {
    expect(PENDING_SEND_TTL_MS).toBeGreaterThan(60 * 60_000)
  })
})
