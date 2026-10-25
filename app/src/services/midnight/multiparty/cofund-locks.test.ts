import {describe, expect, it} from 'vitest'

import {cofundLocks} from './cofund-locks'

const A12 = {groupId: 'group-a12', accountIndex: 0, consumedUtxoIds: ['aa:0']}
const A15 = {groupId: 'group-a15', accountIndex: 0, consumedUtxoIds: ['bb:0', 'bb:1']}

describe('cofundLocks', () => {
  // The defect: a co-funded send locked nothing at all, so every contributor — the composer included —
  // kept offering outputs the transaction had already spent. The contributors are the sharper half:
  // they are not the selected wallet, nothing is listening to them, and their cached set does not
  // change until something opens them.
  it('locks every contributor, not only the first', () => {
    const locks = cofundLocks([A12, A15], ['id-1'], 1000)
    expect(locks.map((l) => l.groupId)).toEqual(['group-a12', 'group-a15'])
    expect(locks[1]?.lock.consumedUtxoIds).toEqual(['bb:0', 'bb:1'])
  })

  it('carries the identifiers, so a lock is released when the chain accounts for it', () => {
    // With none, `releaseUnshieldedLocks` keeps the lock until its TTL — an hour of a contributor's
    // funds held after the transaction has already landed.
    expect(cofundLocks([A12], ['id-1', 'id-2'], 1000)[0]?.lock.identifiers).toEqual(['id-1', 'id-2'])
  })

  it('gives every lock the same expiry, which is the transaction s own TTL', () => {
    expect(cofundLocks([A12, A15], [], 4242).map((l) => l.lock.expiresAt)).toEqual([4242, 4242])
  })

  it('writes nothing for a contributor that spends nothing', () => {
    expect(cofundLocks([{...A12, consumedUtxoIds: []}], ['id-1'], 1000)).toEqual([])
  })
})
