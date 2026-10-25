/**
 * Unit tests for the per-chain adaptive sync scheduler.
 *
 * Validates that the scheduler correctly manages per-chain state, tracks
 * `lastChanged` timestamps for downstream consumers (usePortfolioAssets),
 * and propagates sync results to the state Ref.
 *
 * The scheduler uses `Effect.forkDaemon` internally, so tests run the full
 * Effect via `Effect.runPromise` and use real sleeps to let fibers complete.
 *
 * @module
 */

import {BITCOIN_MAINNET, CARDANO_MAINNET, type ChainId, ETHEREUM_MAINNET} from '@pnyx/config'
import {Effect, Ref} from 'effect'
import {describe, expect, it} from 'vitest'
import type {WalletGroupId} from '../types.js'
import {type ChainWalletKey, createChainSyncScheduler} from './chain-sync-scheduler.js'

const groupId = 'group-1' as WalletGroupId
const chains: ReadonlyArray<{groupId: WalletGroupId; chainId: ChainId}> = [
  {groupId, chainId: CARDANO_MAINNET},
  {groupId, chainId: ETHEREUM_MAINNET},
  {groupId, chainId: BITCOIN_MAINNET},
]

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

describe('ChainSyncScheduler', () => {
  describe('start', () => {
    it('initialises state entries for all chains', async () => {
      const scheduler = await Effect.runPromise(createChainSyncScheduler({baseIntervalMs: 600_000, staggerMs: 0}))

      const syncer = () => Effect.never as Effect.Effect<boolean, Error>
      await Effect.runPromise(scheduler.start(chains, groupId, syncer))

      const states = await Effect.runPromise(Ref.get(scheduler.states))
      expect(states.size).toBe(3)
      expect(states.has(`${groupId}:${CARDANO_MAINNET}` as ChainWalletKey)).toBe(true)
      expect(states.has(`${groupId}:${ETHEREUM_MAINNET}` as ChainWalletKey)).toBe(true)
      expect(states.has(`${groupId}:${BITCOIN_MAINNET}` as ChainWalletKey)).toBe(true)

      await Effect.runPromise(scheduler.stop())
    })
  })

  describe('sync cycle', () => {
    it('sets lastChanged when syncer reports data changed', async () => {
      const scheduler = await Effect.runPromise(createChainSyncScheduler({baseIntervalMs: 600_000, staggerMs: 0}))

      const syncer = () => Effect.succeed(true)
      await Effect.runPromise(scheduler.start(chains, groupId, syncer))

      // Give daemon fibers time to run one sync cycle
      await sleep(200)

      const states = await Effect.runPromise(Ref.get(scheduler.states))
      const cardanoState = states.get(`${groupId}:${CARDANO_MAINNET}` as ChainWalletKey)
      const ethState = states.get(`${groupId}:${ETHEREUM_MAINNET}` as ChainWalletKey)

      expect(cardanoState).toBeDefined()
      expect(cardanoState?.lastChanged).toBeDefined()
      expect(cardanoState?.lastChanged).toBeGreaterThan(0)

      expect(ethState).toBeDefined()
      expect(ethState?.lastChanged).toBeDefined()
      expect(ethState?.lastChanged).toBeGreaterThan(0)

      await Effect.runPromise(scheduler.stop())
    })

    it('does not set lastChanged when syncer reports no change', async () => {
      const scheduler = await Effect.runPromise(createChainSyncScheduler({baseIntervalMs: 600_000, staggerMs: 0}))

      const syncer = () => Effect.succeed(false)
      await Effect.runPromise(scheduler.start(chains, groupId, syncer))

      await sleep(200)

      const states = await Effect.runPromise(Ref.get(scheduler.states))
      const cardanoState = states.get(`${groupId}:${CARDANO_MAINNET}` as ChainWalletKey)

      expect(cardanoState).toBeDefined()
      expect(cardanoState?.lastSynced).toBeDefined()
      expect(cardanoState?.lastChanged).toBeUndefined()

      await Effect.runPromise(scheduler.stop())
    })

    it('records error state when syncer fails', async () => {
      const scheduler = await Effect.runPromise(createChainSyncScheduler({baseIntervalMs: 600_000, staggerMs: 0}))

      const syncer = () => Effect.fail(new Error('Network timeout'))
      await Effect.runPromise(scheduler.start(chains, groupId, syncer))

      await sleep(200)

      const states = await Effect.runPromise(Ref.get(scheduler.states))
      const cardanoState = states.get(`${groupId}:${CARDANO_MAINNET}` as ChainWalletKey)

      expect(cardanoState).toBeDefined()
      expect(cardanoState?.status).toBe('error')
      expect(cardanoState?.lastError).toBe('Network timeout')

      await Effect.runPromise(scheduler.stop())
    })

    it('handles mixed success and failure across chains', async () => {
      const scheduler = await Effect.runPromise(createChainSyncScheduler({baseIntervalMs: 600_000, staggerMs: 0}))

      const syncer = (_groupId: WalletGroupId, chainId: ChainId) => {
        if (chainId === CARDANO_MAINNET) return Effect.succeed(true)
        if (chainId === ETHEREUM_MAINNET) return Effect.fail(new Error('RPC error'))
        return Effect.succeed(false)
      }
      await Effect.runPromise(scheduler.start(chains, groupId, syncer))

      await sleep(200)

      const states = await Effect.runPromise(Ref.get(scheduler.states))

      const cardano = states.get(`${groupId}:${CARDANO_MAINNET}` as ChainWalletKey)
      expect(cardano).toBeDefined()
      expect(cardano?.status).toBe('idle')
      expect(cardano?.lastChanged).toBeDefined()

      const eth = states.get(`${groupId}:${ETHEREUM_MAINNET}` as ChainWalletKey)
      expect(eth).toBeDefined()
      expect(eth?.status).toBe('error')
      expect(eth?.lastError).toBe('RPC error')

      const btc = states.get(`${groupId}:${BITCOIN_MAINNET}` as ChainWalletKey)
      expect(btc).toBeDefined()
      expect(btc?.status).toBe('idle')
      expect(btc?.lastChanged).toBeUndefined()

      await Effect.runPromise(scheduler.stop())
    })
  })

  describe('boostChain', () => {
    it('restarts a chain fiber for immediate re-sync', async () => {
      let cardanoSyncCount = 0
      const scheduler = await Effect.runPromise(
        createChainSyncScheduler({
          baseIntervalMs: 600_000,
          postTxIntervalMs: 50,
          postTxDurationMs: 2000,
          staggerMs: 0,
        }),
      )

      const syncer = (_groupId: WalletGroupId, chainId: ChainId) => {
        if (chainId === CARDANO_MAINNET) cardanoSyncCount++
        return Effect.succeed(true)
      }
      await Effect.runPromise(scheduler.start(chains, groupId, syncer))

      await sleep(200)
      const countAfterFirstSync = cardanoSyncCount

      // Boost cardano — should restart its fiber and sync immediately
      await Effect.runPromise(scheduler.boostChain(groupId, CARDANO_MAINNET))
      await sleep(200)

      expect(cardanoSyncCount).toBeGreaterThan(countAfterFirstSync)

      await Effect.runPromise(scheduler.stop())
    })

    it('does not cut off a sync already running', async () => {
      // ⚠️ The behaviour change behind waking rather than re-forking. `boostChain` used to
      // `Fiber.interrupt` the chain's fiber and start a new one — which, if the boost landed while a
      // sync was in flight, killed it partway. A sync is a chain read and a cache write; interrupting
      // one is not free. Waking a *parked* loop cannot do that, because a running loop is not parked.
      let started = 0
      let finished = 0
      const scheduler = await Effect.runPromise(
        createChainSyncScheduler({baseIntervalMs: 600_000, postTxIntervalMs: 50, staggerMs: 0}),
      )

      const syncer = (_groupId: WalletGroupId, chainId: ChainId) => {
        if (chainId !== CARDANO_MAINNET) return Effect.succeed(false)
        started += 1
        // Long enough that the boost below lands mid-flight.
        return Effect.sleep(300).pipe(
          Effect.map(() => {
            finished += 1
            return true
          }),
        )
      }
      await Effect.runPromise(scheduler.start(chains, groupId, syncer))

      await sleep(60)
      expect(started).toBe(1)
      // Lands ~60 ms into a 300 ms sync, so squarely mid-flight.
      await Effect.runPromise(scheduler.boostChain(groupId, CARDANO_MAINNET))

      // Just past when that first sync should complete, and before a boosted second one could.
      await sleep(280)
      // Not `finished === started`: with the boost's 50 ms interval a second sync is already running by
      // now, and asserting on a count that includes it would be racy. The claim is narrower and is the
      // one that matters — the sync the boost interrupted under the old code ran to completion.
      expect(finished).toBeGreaterThanOrEqual(1)

      await Effect.runPromise(scheduler.stop())
    })
  })

  describe('setActiveGroup', () => {
    it('restarts fibers for newly active group', async () => {
      const group2 = 'group-2' as WalletGroupId
      const multiGroupChains = [
        ...chains,
        {groupId: group2, chainId: CARDANO_MAINNET},
        {groupId: group2, chainId: 'solana' as ChainId},
      ]

      let group2SyncCount = 0
      const scheduler = await Effect.runPromise(createChainSyncScheduler({baseIntervalMs: 600_000, staggerMs: 0}))

      const syncer = (gId: WalletGroupId, _chainId: ChainId) => {
        if (gId === group2) group2SyncCount++
        return Effect.succeed(false)
      }

      await Effect.runPromise(scheduler.start(multiGroupChains, groupId, syncer))
      await sleep(200)
      const countBeforeSwitch = group2SyncCount

      // Switch active group — should restart group-2 fibers
      await Effect.runPromise(scheduler.setActiveGroup(group2))
      await sleep(200)

      expect(group2SyncCount).toBeGreaterThan(countBeforeSwitch)

      await Effect.runPromise(scheduler.stop())
    })
  })

  describe('stop', () => {
    it('interrupts all fibers', async () => {
      let syncCount = 0
      const scheduler = await Effect.runPromise(createChainSyncScheduler({baseIntervalMs: 100, staggerMs: 0}))

      const syncer = () => {
        syncCount++
        return Effect.succeed(false)
      }
      await Effect.runPromise(scheduler.start(chains, groupId, syncer))

      await sleep(300)
      await Effect.runPromise(scheduler.stop())

      const countAtStop = syncCount
      await sleep(500)

      // No more syncs should happen after stop
      expect(syncCount).toBe(countAtStop)
    })
  })
})
