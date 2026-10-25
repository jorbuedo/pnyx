import {describe, expect, it} from 'vitest'

import type {MidnightActivity} from './midnight-activity'
import {midnightTokenActivity} from './midnight-token-activity'
import {NIGHT_TOKEN_TYPE} from './unshielded-utxo-set'

const OTHER = 'ff00000000000000000000000000000000000000000000000000000000000000'

const activity = (tokens: readonly string[], hash = 'aa'): MidnightActivity => ({
  transactionId: 1,
  hash,
  direction: 'received',
  netByToken: new Map(tokens.map((token) => [token, 1n])),
  tokens: new Set(tokens),
  ourSpentCount: 1,
  ourCreatedCount: 1,
  counterparties: [],
  identifiers: [],
})

/**
 * A self-send: the token moved, and the net cancelled to nothing.
 *
 * This is the shape that used to vanish. `netByToken` drops a zero entry, so filtering on it made a
 * transaction that plainly moved NIGHT invisible in NIGHT's own activity list — while the wallet-wide
 * list and the home widget both showed it, because they never asked per token.
 */
const selfSend = (tokens: readonly string[], hash = 'self'): MidnightActivity => ({
  transactionId: 2,
  hash,
  direction: 'self',
  netByToken: new Map(),
  tokens: new Set(tokens),
  ourSpentCount: 1,
  ourCreatedCount: 1,
  counterparties: [],
  identifiers: [],
})

describe('midnightTokenActivity', () => {
  it('reports shielded history as unavailable, never as empty', () => {
    // "No activity" would claim a holding never moved; the truth is we cannot see whether it did.
    expect(midnightTokenActivity({rail: 'shielded', tokenType: NIGHT_TOKEN_TYPE, items: []})).toEqual({
      kind: 'unavailable',
    })
    expect(
      midnightTokenActivity({rail: 'shielded', tokenType: NIGHT_TOKEN_TYPE, items: [activity([NIGHT_TOKEN_TYPE])]}),
    ).toEqual({kind: 'unavailable'})
  })

  it('separates an unread address from a token that did not move', () => {
    expect(midnightTokenActivity({rail: 'unshielded', tokenType: NIGHT_TOKEN_TYPE, items: null})).toEqual({
      kind: 'unknown',
    })
    expect(midnightTokenActivity({rail: 'unshielded', tokenType: NIGHT_TOKEN_TYPE, items: []})).toEqual({kind: 'empty'})
  })

  it('keeps only transactions that moved this token', () => {
    const result = midnightTokenActivity({
      rail: 'unshielded',
      tokenType: NIGHT_TOKEN_TYPE,
      items: [
        activity([NIGHT_TOKEN_TYPE], 'night'),
        activity([OTHER], 'other'),
        activity([OTHER, NIGHT_TOKEN_TYPE], 'both'),
      ],
    })
    expect(result.kind).toBe('list')
    expect(result.kind === 'list' ? result.items.map((i) => i.hash) : []).toEqual(['night', 'both'])
  })

  it('keeps a self-send, whose net cancelled to nothing', () => {
    const result = midnightTokenActivity({
      rail: 'unshielded',
      tokenType: NIGHT_TOKEN_TYPE,
      items: [selfSend([NIGHT_TOKEN_TYPE])],
    })
    expect(result.kind).toBe('list')
    expect(result.kind === 'list' ? result.items.map((i) => i.hash) : []).toEqual(['self'])
  })

  it('still excludes a self-send of some other token', () => {
    expect(
      midnightTokenActivity({rail: 'unshielded', tokenType: NIGHT_TOKEN_TYPE, items: [selfSend([OTHER])]}),
    ).toEqual({kind: 'empty'})
  })

  it('reports empty when the wallet has activity but none for this token', () => {
    expect(
      midnightTokenActivity({rail: 'unshielded', tokenType: NIGHT_TOKEN_TYPE, items: [activity([OTHER])]}),
    ).toEqual({kind: 'empty'})
  })
})
