import {describe, expect, it} from 'vitest'

import {liveLocks, parseStoredLocks, type UnshieldedLock, unshieldedUtxoId} from './unshielded-pending-store'
import type {UnshieldedUtxo} from './unshielded-utxo-set'

const lock = (over: Partial<UnshieldedLock> = {}): UnshieldedLock => ({
  consumedUtxoIds: ['aa:0'],
  expiresAt: 1_700_003_600,
  identifiers: ['id-1'],
  ...over,
})

describe('unshieldedUtxoId', () => {
  // Selection and locking must agree on identity or a lock silently protects nothing, so the id is
  // derived from the same two fields the indexer uses to name an output.
  it('is the outpoint, intent hash and output index', () => {
    const utxo = {intentHash: 'ab'.repeat(32), outputIndex: 3} as UnshieldedUtxo
    expect(unshieldedUtxoId(utxo)).toBe(`${'ab'.repeat(32)}:3`)
  })

  it('tells two outputs of one intent apart', () => {
    const first = {intentHash: 'cd', outputIndex: 0} as UnshieldedUtxo
    const second = {intentHash: 'cd', outputIndex: 1} as UnshieldedUtxo
    expect(unshieldedUtxoId(first)).not.toBe(unshieldedUtxoId(second))
  })
})

describe('liveLocks', () => {
  it('keeps a lock up to and including its expiry', () => {
    expect(liveLocks([lock()], 1_700_003_599)).toHaveLength(1)
    expect(liveLocks([lock()], 1_700_003_600)).toHaveLength(1)
  })

  // Past the TTL the node can never accept the transaction, so holding its inputs back only costs the
  // user their funds. Before it, releasing would invite a genuine double-spend — hence the exact bound.
  it('drops a lock once its transaction can no longer be accepted', () => {
    expect(liveLocks([lock()], 1_700_003_601)).toHaveLength(0)
  })

  it('keeps and drops independently', () => {
    const live = liveLocks([lock({expiresAt: 10}), lock({expiresAt: 100})], 50)
    expect(live.map((l) => l.expiresAt)).toEqual([100])
  })
})

describe('parseStoredLocks', () => {
  it('reads a stored list', () => {
    expect(parseStoredLocks(JSON.stringify([lock()]))).toEqual([lock()])
  })

  it('reads absence as no locks', () => {
    expect(parseStoredLocks(null)).toEqual([])
    expect(parseStoredLocks('')).toEqual([])
  })

  // Dropping a row *unlocks* its inputs, which is the direction that can double-spend — so each of
  // these is logged rather than passed over. Refusing the whole file instead would lock the wallet out
  // of every input it owns because one row went bad.
  it.each([
    ['not json', 'nope'],
    ['not a list', JSON.stringify({consumedUtxoIds: []})],
  ])('treats %s as no locks at all', (_label, raw) => {
    expect(parseStoredLocks(raw)).toEqual([])
  })

  it('drops only the malformed rows', () => {
    const raw = JSON.stringify([lock(), {consumedUtxoIds: 'aa:0', expiresAt: 1, identifiers: []}, lock()])
    expect(parseStoredLocks(raw)).toHaveLength(2)
  })

  it.each([
    ['ids not a list', {...lock(), consumedUtxoIds: 'aa:0'}],
    ['expiry not a number', {...lock(), expiresAt: 'later'}],
    ['identifiers not a list', {...lock(), identifiers: 7}],
  ])('drops a row whose %s', (_label, row) => {
    expect(parseStoredLocks(JSON.stringify([row]))).toEqual([])
  })
})
