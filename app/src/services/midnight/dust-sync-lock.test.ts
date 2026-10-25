/**
 * The DUST sync permit: one rebuild at a time per wallet, and callers wait rather than skip.
 *
 * @module
 */

import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'

import {withDustSyncPermit} from './dust-sync-lock'

/** A task that records overlap: it fails the test itself if a second one starts while it runs. */
const tracked = (log: string[], label: string, ms: number) =>
  Effect.gen(function* () {
    log.push(`${label}:start`)
    yield* Effect.sleep(ms)
    log.push(`${label}:end`)
    return label
  })

describe('the dust sync permit', () => {
  it('serialises two syncs for the same wallet', async () => {
    const log: string[] = []
    await Effect.runPromise(
      Effect.all(
        [
          withDustSyncPermit('group-a', 0, tracked(log, 'first', 40)),
          withDustSyncPermit('group-a', 0, tracked(log, 'second', 10)),
        ],
        {concurrency: 'unbounded'},
      ),
    )
    // Interleaved starts would read start,start,end,end. The rebuild is a 70-90s native replay over
    // both Merkle trees, so two at once on a phone is contention for no benefit.
    expect(log).toEqual(['first:start', 'first:end', 'second:start', 'second:end'])
  })

  it('lets different wallets run at the same time', async () => {
    const log: string[] = []
    await Effect.runPromise(
      Effect.all(
        [
          withDustSyncPermit('group-a', 0, tracked(log, 'a', 30)),
          withDustSyncPermit('group-b', 0, tracked(log, 'b', 10)),
        ],
        {concurrency: 'unbounded'},
      ),
    )
    // Two wallets' rebuilds do not contend for the same state, and serialising them would make a
    // multi-wallet sweep needlessly slow.
    expect(log.slice(0, 2)).toEqual(['a:start', 'b:start'])
  })

  it('treats two accounts of one wallet as separate', async () => {
    const log: string[] = []
    await Effect.runPromise(
      Effect.all(
        [
          withDustSyncPermit('group-a', 0, tracked(log, 'acct0', 30)),
          withDustSyncPermit('group-a', 1, tracked(log, 'acct1', 10)),
        ],
        {concurrency: 'unbounded'},
      ),
    )
    expect(log.slice(0, 2)).toEqual(['acct0:start', 'acct1:start'])
  })

  it('runs the second caller rather than skipping it', async () => {
    // ⚠️ Waiting, not deduplicating. Skipping would make a refresh button do nothing while a background
    // tick happened to be running, and sharing the first result would answer a different question —
    // callers pass their own `atUnixSecs` and their own repair list.
    const log: string[] = []
    const results = await Effect.runPromise(
      Effect.all(
        [
          withDustSyncPermit('group-c', 0, tracked(log, 'scheduled', 20)),
          withDustSyncPermit('group-c', 0, tracked(log, 'manual', 5)),
        ],
        {concurrency: 'unbounded'},
      ),
    )
    expect(results).toEqual(['scheduled', 'manual'])
    expect(log.filter((one) => one.endsWith(':start'))).toHaveLength(2)
  })

  it('releases the permit when a sync fails', async () => {
    // A failed rebuild must not wedge the wallet: the next caller has to be able to try.
    const failed = await Effect.runPromise(
      Effect.either(withDustSyncPermit('group-d', 0, Effect.fail('indexer down' as const))),
    )
    expect(failed._tag).toBe('Left')
    const after = await Effect.runPromise(withDustSyncPermit('group-d', 0, Effect.succeed('ok')))
    expect(after).toBe('ok')
  })
})
