import {describe, expect, it} from '@effect/vitest'
import {Effect} from 'effect'
import type {WalletGroup, WalletGroupId, WalletSyncState} from '../types.js'
import {
  backoffDelay,
  calculateBackoff,
  createBackoffState,
  DEFAULT_BACKOFF_CONFIG,
  resetBackoff,
  shouldRetry,
  withBackoff,
} from './backoff.js'
import {getNextSyncTime, getWalletsNeedingSync, needsSync, parallelSync, prioritizeWallets} from './sync-strategies.js'

describe('backoff', () => {
  describe('createBackoffState', () => {
    it('creates initial state', () => {
      const state = createBackoffState()
      expect(state.attempt).toBe(0)
      expect(state.nextDelay).toBe(0)
      expect(state.lastAttempt).toBeUndefined()
    })
  })

  describe('calculateBackoff', () => {
    it('calculates exponential delay', () => {
      let state = createBackoffState()

      // First attempt
      const first = calculateBackoff(state, DEFAULT_BACKOFF_CONFIG)
      expect(first.delay).toBeGreaterThanOrEqual(500) // 1000 * 0.5
      expect(first.delay).toBeLessThanOrEqual(1500) // 1000 * 1.5
      expect(first.nextState.attempt).toBe(1)

      // Second attempt
      state = first.nextState
      const second = calculateBackoff(state, DEFAULT_BACKOFF_CONFIG)
      expect(second.delay).toBeGreaterThanOrEqual(1000) // 2000 * 0.5
      expect(second.delay).toBeLessThanOrEqual(3000) // 2000 * 1.5
      expect(second.nextState.attempt).toBe(2)
    })

    it('respects max delay', () => {
      const state = {...createBackoffState(), attempt: 100}
      const result = calculateBackoff(state, {initial: 1000, max: 5000, multiplier: 2})
      expect(result.delay).toBeLessThanOrEqual(7500) // 5000 * 1.5
    })

    it('uses custom config', () => {
      const state = createBackoffState()
      const config = {initial: 500, max: 2000, multiplier: 3}
      const result = calculateBackoff(state, config)
      expect(result.delay).toBeGreaterThanOrEqual(250) // 500 * 0.5
      expect(result.delay).toBeLessThanOrEqual(750) // 500 * 1.5
    })
  })

  describe('resetBackoff', () => {
    it('resets attempt count', () => {
      const state = {attempt: 5, lastAttempt: new Date(), nextDelay: 10000}
      const reset = resetBackoff(state)
      expect(reset.attempt).toBe(0)
      expect(reset.nextDelay).toBe(0)
      expect(reset.lastAttempt).toBe(state.lastAttempt) // Preserves last attempt time
    })
  })

  describe('shouldRetry', () => {
    it('returns true if under max attempts', () => {
      expect(shouldRetry({attempt: 3, nextDelay: 0}, 5)).toBe(true)
    })

    it('returns false if at max attempts', () => {
      expect(shouldRetry({attempt: 5, nextDelay: 0}, 5)).toBe(false)
    })

    it('returns false if over max attempts', () => {
      expect(shouldRetry({attempt: 10, nextDelay: 0}, 5)).toBe(false)
    })
  })

  describe('backoffDelay', () => {
    it('returns a promise that resolves', async () => {
      const start = Date.now()
      await backoffDelay(10)
      const elapsed = Date.now() - start
      expect(elapsed).toBeGreaterThanOrEqual(9)
    })
  })

  describe('withBackoff', () => {
    it('succeeds on first try', async () => {
      let attempts = 0
      const result = await withBackoff(
        async () => {
          attempts++
          return 'success'
        },
        {initial: 10, max: 100, multiplier: 2},
        3,
      )
      expect(result).toBe('success')
      expect(attempts).toBe(1)
    })

    it('retries on failure and succeeds', async () => {
      let attempts = 0
      const result = await withBackoff(
        async () => {
          attempts++
          if (attempts < 3) throw new Error('fail')
          return 'success'
        },
        {initial: 1, max: 10, multiplier: 2},
        5,
      )
      expect(result).toBe('success')
      expect(attempts).toBe(3)
    })

    it('throws after max attempts', async () => {
      let attempts = 0
      await expect(
        withBackoff(
          async () => {
            attempts++
            throw new Error('always fails')
          },
          {initial: 1, max: 10, multiplier: 2},
          3,
        ),
      ).rejects.toThrow('always fails')
      expect(attempts).toBe(3)
    })
  })
})

describe('sync-strategies', () => {
  const asGroupId = (id: string): WalletGroupId => id as WalletGroupId

  const createWallet = (id: string, createdAt: Date): WalletGroup => ({
    groupId: asGroupId(id),
    name: `Wallet ${id}`,
    createdAt,
    source: 'mnemonic',
    chains: new Map(),
  })

  const createSyncState = (groupId: string, lastSynced?: Date): WalletSyncState => ({
    groupId: asGroupId(groupId),
    state: 'idle',
    ...(lastSynced ? {lastSynced} : {}),
  })

  describe('prioritizeWallets', () => {
    it('prioritizes selected wallet first', () => {
      const wallets = new Map<WalletGroupId, WalletGroup>([
        [asGroupId('w1'), createWallet('w1', new Date('2024-01-01'))],
        [asGroupId('w2'), createWallet('w2', new Date('2024-01-02'))],
        [asGroupId('w3'), createWallet('w3', new Date('2024-01-03'))],
      ])
      const states = new Map<WalletGroupId, WalletSyncState>()
      const selected = asGroupId('w2')
      const prioritized = prioritizeWallets(wallets, states, selected, 'lastSelected')
      expect(prioritized[0]).toBe('w2')
    })

    it('prioritizes oldest synced with oldest strategy', () => {
      const wallets = new Map<WalletGroupId, WalletGroup>([
        [asGroupId('w1'), createWallet('w1', new Date())],
        [asGroupId('w2'), createWallet('w2', new Date())],
      ])
      const states = new Map<WalletGroupId, WalletSyncState>([
        [asGroupId('w1'), createSyncState('w1', new Date('2024-01-02'))],
        [asGroupId('w2'), createSyncState('w2', new Date('2024-01-01'))],
      ])

      const prioritized = prioritizeWallets(wallets, states, null, 'oldest')
      expect(prioritized[0]).toBe('w2')
    })

    it('returns arbitrary order with none strategy', () => {
      const wallets = new Map<WalletGroupId, WalletGroup>([
        [asGroupId('w1'), createWallet('w1', new Date())],
        [asGroupId('w2'), createWallet('w2', new Date())],
      ])
      const states = new Map<WalletGroupId, WalletSyncState>()

      const prioritized = prioritizeWallets(wallets, states, null, 'none')
      expect(prioritized).toHaveLength(2)
    })
  })

  describe('parallelSync', () => {
    it.effect('syncs wallets in parallel', () =>
      Effect.gen(function* () {
        const synced: string[] = []
        const syncFn = (id: string) =>
          Effect.sync(() => {
            synced.push(id)
          })

        const walletIds = [asGroupId('w1'), asGroupId('w2'), asGroupId('w3')]
        const results = yield* parallelSync(walletIds, syncFn, 2, 0)

        expect(synced).toHaveLength(3)
        expect(results.size).toBe(3)
        expect(results.get(asGroupId('w1'))).toBeNull()
      }),
    )

    it.effect('handles errors per wallet', () =>
      Effect.gen(function* () {
        const syncFn = (id: string) => (id === 'w2' ? Effect.fail(new Error('Sync failed')) : Effect.succeed(undefined))

        const walletIds = [asGroupId('w1'), asGroupId('w2'), asGroupId('w3')]
        const results = yield* parallelSync(walletIds, syncFn, 3, 0)

        expect(results.get(asGroupId('w1'))).toBeNull()
        expect(results.get(asGroupId('w2'))).toBeInstanceOf(Error)
        expect(results.get(asGroupId('w3'))).toBeNull()
      }),
    )
  })

  describe('getNextSyncTime', () => {
    it('returns now for never-synced wallet', () => {
      const state = createSyncState('w1')
      const next = getNextSyncTime(state, 60000)
      expect(next.getTime()).toBeLessThanOrEqual(Date.now())
    })

    it('calculates next sync time from last sync', () => {
      const lastSynced = new Date(Date.now() - 30000)
      const state = createSyncState('w1', lastSynced)
      const next = getNextSyncTime(state, 60000)
      expect(next.getTime()).toBeCloseTo(lastSynced.getTime() + 60000, -2)
    })
  })

  describe('needsSync', () => {
    it('returns true for never-synced wallet', () => {
      const state = createSyncState('w1')
      expect(needsSync(state, 60000)).toBe(true)
    })

    it('returns false for recently synced wallet', () => {
      const state = createSyncState('w1', new Date())
      expect(needsSync(state, 60000)).toBe(false)
    })

    it('returns true for stale wallet', () => {
      const state = createSyncState('w1', new Date(Date.now() - 120000))
      expect(needsSync(state, 60000)).toBe(true)
    })

    it('returns false while syncing', () => {
      const state = {...createSyncState('w1'), state: 'syncing' as const}
      expect(needsSync(state, 60000)).toBe(false)
    })
  })

  describe('getWalletsNeedingSync', () => {
    it('returns wallets that need syncing', () => {
      const states = new Map<WalletGroupId, WalletSyncState>([
        [asGroupId('w1'), createSyncState('w1')], // Never synced
        [asGroupId('w2'), createSyncState('w2', new Date())], // Just synced
        [asGroupId('w3'), createSyncState('w3', new Date(Date.now() - 120000))], // Stale
      ])

      const needing = getWalletsNeedingSync(states, 60000)
      expect(needing).toContain('w1')
      expect(needing).not.toContain('w2')
      expect(needing).toContain('w3')
    })
  })
})
