import {describe, expect, it} from '@effect/vitest'
import {Effect} from 'effect'
import type {WalletTransaction} from '../types.js'
import {createOptimisticState} from './optimistic.js'
import {
  calculateNetChange,
  classifyTransaction,
  createTransactionSummary,
  filterByDirection,
  getOwnInputs,
  getOwnOutputs,
  getTransactionStatus,
  sortByTime,
} from './transaction-summary.js'

describe('transaction-summary', () => {
  const ownAddresses = new Set(['addr_own1', 'addr_own2', 'stake_own'])

  const createTx = (overrides: Partial<WalletTransaction> = {}): WalletTransaction => ({
    hash: 'txhash123',
    inputs: [],
    outputs: [],
    fee: 200000n,
    certificates: [],
    withdrawals: [],
    validContract: true,
    ...overrides,
  })

  describe('classifyTransaction', () => {
    it('classifies self transaction (all own addresses)', () => {
      const tx = createTx({
        inputs: [{txHash: '1', txIndex: 0, address: 'addr_own1', value: {lovelace: 5000000n}}],
        outputs: [{address: 'addr_own2', value: {lovelace: 4800000n}}],
      })
      expect(classifyTransaction(tx, ownAddresses)).toBe('self')
    })

    it('classifies sent transaction', () => {
      const tx = createTx({
        inputs: [{txHash: '1', txIndex: 0, address: 'addr_own1', value: {lovelace: 5000000n}}],
        outputs: [
          {address: 'addr_foreign', value: {lovelace: 3000000n}},
          {address: 'addr_own2', value: {lovelace: 1800000n}},
        ],
      })
      expect(classifyTransaction(tx, ownAddresses)).toBe('sent')
    })

    it('classifies received transaction', () => {
      const tx = createTx({
        inputs: [{txHash: '1', txIndex: 0, address: 'addr_foreign', value: {lovelace: 5000000n}}],
        outputs: [{address: 'addr_own1', value: {lovelace: 3000000n}}],
      })
      expect(classifyTransaction(tx, ownAddresses)).toBe('received')
    })

    it('classifies multi-party transaction', () => {
      const tx = createTx({
        inputs: [
          {txHash: '1', txIndex: 0, address: 'addr_own1', value: {lovelace: 2000000n}},
          {txHash: '2', txIndex: 0, address: 'addr_foreign', value: {lovelace: 3000000n}},
        ],
        outputs: [{address: 'addr_other', value: {lovelace: 4800000n}}],
      })
      expect(classifyTransaction(tx, ownAddresses)).toBe('multi')
    })

    it('classifies failed contract as self', () => {
      const tx = createTx({
        validContract: false,
        inputs: [{txHash: '1', txIndex: 0, address: 'addr_own1', value: {lovelace: 5000000n}}],
        outputs: [{address: 'addr_foreign', value: {lovelace: 3000000n}}],
      })
      expect(classifyTransaction(tx, ownAddresses)).toBe('self')
    })
  })

  describe('calculateNetChange', () => {
    it('calculates positive change for received', () => {
      const tx = createTx({
        inputs: [{txHash: '1', txIndex: 0, address: 'addr_foreign', value: {lovelace: 5000000n}}],
        outputs: [{address: 'addr_own1', value: {lovelace: 3000000n}}],
      })
      const change = calculateNetChange(tx, ownAddresses)
      expect(change.lovelace).toBe(3000000n)
    })

    it('calculates negative change for sent', () => {
      const tx = createTx({
        inputs: [{txHash: '1', txIndex: 0, address: 'addr_own1', value: {lovelace: 5000000n}}],
        outputs: [
          {address: 'addr_foreign', value: {lovelace: 3000000n}},
          {address: 'addr_own2', value: {lovelace: 1800000n}},
        ],
      })
      const change = calculateNetChange(tx, ownAddresses)
      // Spent 5M, got back 1.8M = -3.2M
      expect(change.lovelace).toBe(-3200000n)
    })

    it('calculates asset changes', () => {
      const tx = createTx({
        inputs: [
          {
            txHash: '1',
            txIndex: 0,
            address: 'addr_own1',
            value: {lovelace: 5000000n, assets: new Map([['policy.asset', 100n]])},
          },
        ],
        outputs: [
          {address: 'addr_foreign', value: {lovelace: 3000000n, assets: new Map([['policy.asset', 80n]])}},
          {address: 'addr_own2', value: {lovelace: 1800000n, assets: new Map([['policy.asset', 20n]])}},
        ],
      })
      const change = calculateNetChange(tx, ownAddresses)
      expect(change.assets.get('policy.asset')).toBe(-80n) // Lost 80 tokens
    })
  })

  describe('getOwnInputs', () => {
    it('returns only own inputs', () => {
      const tx = createTx({
        inputs: [
          {txHash: '1', txIndex: 0, address: 'addr_own1', value: {lovelace: 2000000n}},
          {txHash: '2', txIndex: 0, address: 'addr_foreign', value: {lovelace: 3000000n}},
        ],
      })
      const ownInputs = getOwnInputs(tx, ownAddresses)
      expect(ownInputs).toHaveLength(1)
      expect(ownInputs[0]?.address).toBe('addr_own1')
    })
  })

  describe('getOwnOutputs', () => {
    it('returns only own outputs', () => {
      const tx = createTx({
        outputs: [
          {address: 'addr_own1', value: {lovelace: 2000000n}},
          {address: 'addr_foreign', value: {lovelace: 3000000n}},
        ],
      })
      const ownOutputs = getOwnOutputs(tx, ownAddresses)
      expect(ownOutputs).toHaveLength(1)
      expect(ownOutputs[0]?.address).toBe('addr_own1')
    })
  })

  describe('getTransactionStatus', () => {
    it('returns pending for pending transactions', () => {
      const tx = createTx()
      expect(getTransactionStatus(tx, true)).toBe('pending')
    })

    it('returns failed for invalid contract', () => {
      const tx = createTx({validContract: false})
      expect(getTransactionStatus(tx, false)).toBe('failed')
    })

    it('returns confirmed for transaction with block', () => {
      const tx = createTx({
        block: {hash: 'block123', height: 100, slot: 12345, time: new Date()},
      })
      expect(getTransactionStatus(tx, false)).toBe('confirmed')
    })

    it('returns pending for unconfirmed non-pending', () => {
      const tx = createTx()
      expect(getTransactionStatus(tx, false)).toBe('pending')
    })
  })

  describe('createTransactionSummary', () => {
    it('creates complete summary', () => {
      const tx = createTx({
        inputs: [{txHash: '1', txIndex: 0, address: 'addr_own1', value: {lovelace: 5000000n}}],
        outputs: [
          {address: 'addr_foreign', value: {lovelace: 3000000n}},
          {address: 'addr_own2', value: {lovelace: 1800000n}},
        ],
        block: {hash: 'block123', height: 100, slot: 12345, time: new Date()},
      })
      const summary = createTransactionSummary(tx, ownAddresses, {confirmations: 10})

      expect(summary.hash).toBe('txhash123')
      expect(summary.direction).toBe('sent')
      expect(summary.status).toBe('confirmed')
      expect(summary.confirmations).toBe(10)
      expect(summary.fee).toBe(200000n)
      expect(summary.ownInputs).toHaveLength(1)
      expect(summary.ownOutputs).toHaveLength(1)
    })
  })

  describe('sortByTime', () => {
    it('sorts transactions newest first', () => {
      const txs = [
        createTx({hash: 'tx1', block: {hash: 'b1', height: 1, slot: 1, time: new Date('2024-01-01')}}),
        createTx({hash: 'tx3', block: {hash: 'b3', height: 3, slot: 3, time: new Date('2024-01-03')}}),
        createTx({hash: 'tx2', block: {hash: 'b2', height: 2, slot: 2, time: new Date('2024-01-02')}}),
      ]
      const sorted = sortByTime(txs)
      expect(sorted[0]?.hash).toBe('tx3')
      expect(sorted[1]?.hash).toBe('tx2')
      expect(sorted[2]?.hash).toBe('tx1')
    })

    it('puts pending transactions first', () => {
      const txs = [
        createTx({hash: 'confirmed', block: {hash: 'b1', height: 1, slot: 1, time: new Date()}}),
        createTx({hash: 'pending'}),
      ]
      const sorted = sortByTime(txs)
      expect(sorted[0]?.hash).toBe('pending')
    })
  })

  describe('filterByDirection', () => {
    it('filters by sent direction', () => {
      const txs = [
        createTx({
          hash: 'sent',
          inputs: [{txHash: '1', txIndex: 0, address: 'addr_own1', value: {lovelace: 5000000n}}],
          outputs: [{address: 'addr_foreign', value: {lovelace: 4800000n}}],
        }),
        createTx({
          hash: 'received',
          inputs: [{txHash: '1', txIndex: 0, address: 'addr_foreign', value: {lovelace: 5000000n}}],
          outputs: [{address: 'addr_own1', value: {lovelace: 3000000n}}],
        }),
      ]
      const filtered = filterByDirection(txs, ownAddresses, 'sent')
      expect(filtered).toHaveLength(1)
      expect(filtered[0]?.hash).toBe('sent')
    })
  })
})

describe('optimistic', () => {
  describe('createOptimisticState', () => {
    it.effect('creates empty state', () =>
      Effect.gen(function* () {
        const state = yield* createOptimisticState()
        const pending = yield* state.getPending()
        expect(pending).toHaveLength(0)
      }),
    )

    it.effect('adds and retrieves pending transactions', () =>
      Effect.gen(function* () {
        const state = yield* createOptimisticState()
        const tx = {
          hash: 'tx123',
          inputs: [],
          outputs: [],
          fee: 200000n,
          certificates: [],
          withdrawals: [],
          validContract: true,
        }

        yield* state.add(tx)
        const pending = yield* state.getPending()
        expect(pending).toHaveLength(1)
        expect(pending[0]?.tx.hash).toBe('tx123')
      }),
    )

    it.effect('confirms transaction', () =>
      Effect.gen(function* () {
        const state = yield* createOptimisticState()
        const tx = {
          hash: 'tx123',
          inputs: [],
          outputs: [],
          fee: 200000n,
          certificates: [],
          withdrawals: [],
          validContract: true,
        }

        yield* state.add(tx)
        const confirmed = yield* state.confirm('tx123')
        expect(confirmed).toBe(true)

        const pending = yield* state.getPending()
        expect(pending).toHaveLength(0)
      }),
    )

    it.effect('removes transaction', () =>
      Effect.gen(function* () {
        const state = yield* createOptimisticState()
        const tx = {
          hash: 'tx123',
          inputs: [],
          outputs: [],
          fee: 200000n,
          certificates: [],
          withdrawals: [],
          validContract: true,
        }

        yield* state.add(tx)
        const removed = yield* state.remove('tx123')
        expect(removed).toBe(true)

        const pending = yield* state.getPending()
        expect(pending).toHaveLength(0)
      }),
    )

    it.effect('clears all transactions', () =>
      Effect.gen(function* () {
        const state = yield* createOptimisticState()
        yield* state.add({
          hash: 'tx1',
          inputs: [],
          outputs: [],
          fee: 0n,
          certificates: [],
          withdrawals: [],
          validContract: true,
        })
        yield* state.add({
          hash: 'tx2',
          inputs: [],
          outputs: [],
          fee: 0n,
          certificates: [],
          withdrawals: [],
          validContract: true,
        })

        yield* state.clear()
        const pending = yield* state.getPending()
        expect(pending).toHaveLength(0)
      }),
    )

    it.effect('fails transaction', () =>
      Effect.gen(function* () {
        const state = yield* createOptimisticState()
        const tx = {
          hash: 'tx123',
          inputs: [],
          outputs: [],
          fee: 200000n,
          certificates: [],
          withdrawals: [],
          validContract: true,
        }

        yield* state.add(tx)
        const failed = yield* state.fail('tx123')
        expect(failed).toBe(true)

        // Failed transactions are not pending
        const pending = yield* state.getPending()
        expect(pending).toHaveLength(0)
      }),
    )

    it.effect('returns false when confirming non-existent tx', () =>
      Effect.gen(function* () {
        const state = yield* createOptimisticState()
        const result = yield* state.confirm('nonexistent')
        expect(result).toBe(false)
      }),
    )

    it.effect('returns false when failing non-existent tx', () =>
      Effect.gen(function* () {
        const state = yield* createOptimisticState()
        const result = yield* state.fail('nonexistent')
        expect(result).toBe(false)
      }),
    )

    it.effect('returns false when removing non-existent tx', () =>
      Effect.gen(function* () {
        const state = yield* createOptimisticState()
        const result = yield* state.remove('nonexistent')
        expect(result).toBe(false)
      }),
    )

    it.effect('checkExpired returns empty for fresh transactions', () =>
      Effect.gen(function* () {
        const state = yield* createOptimisticState()
        const tx = {
          hash: 'tx123',
          inputs: [],
          outputs: [],
          fee: 200000n,
          certificates: [],
          withdrawals: [],
          validContract: true,
        }

        // Add with long timeout
        yield* state.add(tx, {timeoutMs: 600000})

        // Check expired immediately - should be empty
        const expired = yield* state.checkExpired()
        expect(expired).toHaveLength(0)

        // Transaction should still be pending
        const pending = yield* state.getPending()
        expect(pending).toHaveLength(1)
      }),
    )
  })
})
