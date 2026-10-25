import {Effect, Either} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('../../../logger', () => ({
  logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
}))

// react-native-mmkv is a native module and cannot load under vitest, so the backend is a plain map.
// `fail` lets one key be made unreadable, which is how the store's failure channel is exercised.
const disk = new Map<string, string>()
let failOn: string | null = null
let failRemoveOn: string | null = null

vi.mock('../../../platform/storage', () => ({
  storage: {
    get: vi.fn(async (key: string) => {
      if (key === failOn) throw new Error('mmkv refused the read')
      return disk.get(key) ?? null
    }),
    set: vi.fn(async (key: string, value: string) => {
      if (key === failOn) throw new Error('mmkv refused the write')
      disk.set(key, value)
    }),
    remove: vi.fn(async (key: string) => {
      if (key === failRemoveOn) throw new Error('mmkv refused the delete')
      disk.delete(key)
    }),
  },
}))

vi.mock('../../store-change', () => ({
  notifyStoreChange: vi.fn(),
  publishStoreChange: () => Effect.void,
}))

import {
  dustBlockTimeKey,
  dustCursorKey,
  dustNetworkKey,
  dustPendingKey,
  dustSpentKey,
  dustStateKey,
  dustSyncedAtKey,
  dustSyncedWatermarkKey,
  isDustStateFresh,
  loadConfirmedDustState,
  loadDustCursor,
  loadDustState,
  loadDustStateForSpend,
  loadPendingDustSpend,
  markDustSpent,
  parseStoredDustState,
  parseStoredPendingDust,
  parseStoredSyncedAt,
  parseStoredWatermark,
  promotePendingDustSpend,
  saveDustState,
} from './dust-state-store'

const GROUP = 'group-a'
const ACCOUNT = 0
const CONFIRMED = new Uint8Array([0xc0, 0xff, 0xee])
const PENDING = new Uint8Array([0xba, 0xdd])
const hex = (bytes: Uint8Array): string => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)
const runEither = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.either(effect))

beforeEach(() => {
  disk.clear()
  failOn = null
  failRemoveOn = null
  vi.clearAllMocks()
})

describe('the keys', () => {
  it('scope by group and account, so two funds groups cannot share a state', () => {
    expect(dustStateKey('group-a', 0)).toBe('@pnyx/midnight/dust-state/group-a/0')
    expect(dustStateKey('group-a', 1)).not.toBe(dustStateKey('group-a', 0))
    expect(dustStateKey('group-b', 0)).not.toBe(dustStateKey('group-a', 0))
  })

  it('keeps the state and its timestamp under separate keys', () => {
    // So a bad timestamp can never make a good state unreadable.
    expect(dustSyncedAtKey('g', 0)).not.toBe(dustStateKey('g', 0))
  })
})

describe('parseStoredDustState', () => {
  it('reads hex back to bytes', () => {
    expect(parseStoredDustState('00ff10')).toEqual(new Uint8Array([0, 255, 16]))
  })

  it('reads absent as absent', () => {
    expect(parseStoredDustState(null)).toBeUndefined()
    expect(parseStoredDustState('')).toBeUndefined()
  })

  it('discards a corrupt blob rather than throwing', () => {
    // ⚠️ The opposite of `parseStoredState` for the shielded wallet, deliberately. A coin it cannot
    // read exists nowhere else, so that one refuses to proceed. Every DUST entry is re-readable from
    // the indexer, so refusing here would strand a wallet over something a re-sync fixes.
    expect(parseStoredDustState('not hex at all')).toBeUndefined()
    expect(parseStoredDustState('abc')).toBeUndefined()
  })
})

describe('parseStoredSyncedAt', () => {
  it('reads a timestamp', () => {
    expect(parseStoredSyncedAt('1700000000')).toBe(1_700_000_000)
  })

  it('treats absent, zero and nonsense alike as unknown', () => {
    // "Never synced" and "synced at the epoch" must not be confusable: one is safe, one claims currency.
    expect(parseStoredSyncedAt(null)).toBeUndefined()
    expect(parseStoredSyncedAt('0')).toBeUndefined()
    expect(parseStoredSyncedAt('-5')).toBeUndefined()
    expect(parseStoredSyncedAt('yesterday')).toBeUndefined()
  })
})

describe('isDustStateFresh', () => {
  const now = 1_700_000_000

  it('is false when nothing was ever synced', () => {
    // An absent timestamp is not "fresh by default" — that would spend from a state nobody has checked.
    expect(isDustStateFresh(undefined, now, 300)).toBe(false)
  })

  it('is true inside the window', () => {
    expect(isDustStateFresh(now - 100, now, 300)).toBe(true)
  })

  it('is true exactly at the boundary', () => {
    expect(isDustStateFresh(now - 300, now, 300)).toBe(true)
  })

  it('is false past it', () => {
    expect(isDustStateFresh(now - 301, now, 300)).toBe(false)
  })

  it('is true for a timestamp from the future rather than treating it as stale', () => {
    // A clock that moved backwards should not force a re-sync loop; the state is newer than "now".
    expect(isDustStateFresh(now + 60, now, 300)).toBe(true)
  })
})

describe('parseStoredWatermark', () => {
  it('reads a decimal transaction id', () => {
    expect(parseStoredWatermark('570477')).toBe(570_477)
  })

  // Zero is a real watermark — a wallet whose unshielded feed has shown nothing. Rejecting it the way
  // `parseStoredSyncedAt` rejects a zero timestamp would leave that wallet permanently "unknown".
  it('keeps zero, unlike a stored timestamp', () => {
    expect(parseStoredWatermark('0')).toBe(0)
    expect(parseStoredSyncedAt('0')).toBeUndefined()
  })

  it('reports absence for anything unusable', () => {
    expect(parseStoredWatermark(null)).toBeUndefined()
    expect(parseStoredWatermark('')).toBeUndefined()
    expect(parseStoredWatermark('-1')).toBeUndefined()
    expect(parseStoredWatermark('not a number')).toBeUndefined()
  })
})

describe('dustSpentKey', () => {
  // The flag is what lets `syncDust` refuse instead of rebuilding a wallet into unspendable outputs,
  // so it must be scoped per account the way every other DUST key is.
  it('scopes per wallet and account', () => {
    expect(dustSpentKey('g1', 0)).toBe('@pnyx/midnight/dust-spent/g1/0')
    expect(dustSpentKey('g1', 1)).not.toBe(dustSpentKey('g1', 0))
    expect(dustSpentKey('g2', 0)).not.toBe(dustSpentKey('g1', 0))
  })
})

describe('parseStoredPendingDust', () => {
  const stored = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({state: 'aabb', expiresAt: 1_700_003_600, identifiers: ['id-1'], ...over})

  it('reads a pending spend', () => {
    const pending = parseStoredPendingDust(stored())
    expect(pending?.expiresAt).toBe(1_700_003_600)
    expect(pending?.identifiers).toEqual(['id-1'])
    expect(pending?.state).toEqual(new Uint8Array([0xaa, 0xbb]))
  })

  // Absent beats wrong: a malformed record must not be adopted as a spend, because doing so would hide
  // a DUST output the wallet still owns. Reverting to the confirmed state is always the safe direction.
  it.each([
    ['not json', 'not json'],
    ['no state', JSON.stringify({expiresAt: 1, identifiers: []})],
    ['state not hex', stored({state: 'zz'})],
    ['expiry not a number', stored({expiresAt: 'soon'})],
    ['identifiers not a list', stored({identifiers: 'id-1'})],
  ])('treats %s as absent', (_label, raw) => {
    expect(parseStoredPendingDust(raw)).toBeUndefined()
  })

  it('drops identifiers that are not strings rather than the whole record', () => {
    expect(parseStoredPendingDust(stored({identifiers: ['id-1', 7, null]}))?.identifiers).toEqual(['id-1'])
  })
})

describe('the network stamp', () => {
  it('reports no state when the stored one belongs to another network', async () => {
    disk.set(dustStateKey(GROUP, ACCOUNT), hex(CONFIRMED))
    disk.set(dustNetworkKey(GROUP, ACCOUNT), 'mainnet')
    // The defect this guards: an unstamped state made a network switch show another chain's DUST.
    expect(await run(loadConfirmedDustState(GROUP, ACCOUNT, 'preprod'))).toBeUndefined()
  })

  it('reads the state when the stamp matches', async () => {
    disk.set(dustStateKey(GROUP, ACCOUNT), hex(CONFIRMED))
    disk.set(dustNetworkKey(GROUP, ACCOUNT), 'preprod')
    expect(await run(loadConfirmedDustState(GROUP, ACCOUNT, 'preprod'))).toEqual(CONFIRMED)
  })

  it('takes a pending spend out of scope with the state it describes', async () => {
    disk.set(dustStateKey(GROUP, ACCOUNT), hex(CONFIRMED))
    disk.set(dustNetworkKey(GROUP, ACCOUNT), 'mainnet')
    disk.set(
      dustPendingKey(GROUP, ACCOUNT),
      JSON.stringify({state: hex(PENDING), expiresAt: 4_000_000_000, identifiers: ['a']}),
    )
    expect(await run(loadDustState(GROUP, ACCOUNT, 'preprod'))).toBeUndefined()
  })
})

describe('the pending spend', () => {
  beforeEach(() => {
    disk.set(dustStateKey(GROUP, ACCOUNT), hex(CONFIRMED))
    disk.set(dustNetworkKey(GROUP, ACCOUNT), 'preprod')
  })

  it('is what a spend reads while it stands', async () => {
    disk.set(
      dustPendingKey(GROUP, ACCOUNT),
      JSON.stringify({state: hex(PENDING), expiresAt: 4_000_000_000, identifiers: ['a']}),
    )
    expect(await run(loadDustState(GROUP, ACCOUNT, 'preprod'))).toEqual(PENDING)
  })

  it('self-heals past its TTL, and the confirmed state comes back', async () => {
    disk.set(dustPendingKey(GROUP, ACCOUNT), JSON.stringify({state: hex(PENDING), expiresAt: 1, identifiers: ['a']}))
    expect(await run(loadPendingDustSpend(GROUP, ACCOUNT, 2))).toBeUndefined()
    // Cleared from disk, not merely ignored — otherwise every later read pays for the same decision.
    expect(disk.has(dustPendingKey(GROUP, ACCOUNT))).toBe(false)
    expect(await run(loadDustState(GROUP, ACCOUNT, 'preprod'))).toEqual(CONFIRMED)
  })

  it('promotes by writing the confirmed state before clearing the pending one', async () => {
    disk.set(
      dustPendingKey(GROUP, ACCOUNT),
      JSON.stringify({state: hex(PENDING), expiresAt: 4_000_000_000, identifiers: ['a']}),
    )
    expect(await run(promotePendingDustSpend(GROUP, ACCOUNT))).toBe(true)
    expect(disk.get(dustStateKey(GROUP, ACCOUNT))).toBe(hex(PENDING))
    expect(disk.has(dustPendingKey(GROUP, ACCOUNT))).toBe(false)
  })

  it('survives a crash between its two writes without reverting the spend', async () => {
    // The ordering claim in the module doc, tested rather than asserted: confirmed first, pending
    // cleared second. Failing the *second* step must leave the promoted state in place — the reverse
    // order would clear the pending row and then fail to write it, handing the next transfer an output
    // the chain has already consumed. An end-state assertion cannot see this; both orders end the same.
    disk.set(
      dustPendingKey(GROUP, ACCOUNT),
      JSON.stringify({state: hex(PENDING), expiresAt: 4_000_000_000, identifiers: ['a']}),
    )
    failRemoveOn = dustPendingKey(GROUP, ACCOUNT)
    const outcome = await runEither(promotePendingDustSpend(GROUP, ACCOUNT))
    expect(Either.isLeft(outcome)).toBe(true)
    expect(disk.get(dustStateKey(GROUP, ACCOUNT))).toBe(hex(PENDING))
  })

  it('promotes nothing when none stands', async () => {
    expect(await run(promotePendingDustSpend(GROUP, ACCOUNT))).toBe(false)
    expect(disk.get(dustStateKey(GROUP, ACCOUNT))).toBe(hex(CONFIRMED))
  })
})

describe('loadDustStateForSpend', () => {
  const CURSOR = {nextGeneration: 1, nextCommitment: 1}

  // ⚠️ The reason this exists: a state from one sync paired with another sync's block time proves roots
  // the node does not have, and it reports that as a bad proof rather than as a mismatch. Reading them
  // apart across a build produced exactly that on device.
  it('returns the state with the block time stored beside it', async () => {
    await run(saveDustState(GROUP, ACCOUNT, CONFIRMED, 1_700_000_000, 'preprod', 1_699_000_000, CURSOR))
    expect(await run(loadDustStateForSpend(GROUP, ACCOUNT, 'preprod'))).toEqual({
      state: CONFIRMED,
      blockTimeSecs: 1_699_000_000,
    })
  })

  it('reports a state with no block time as 0 rather than hiding it', async () => {
    await run(saveDustState(GROUP, ACCOUNT, CONFIRMED, 1_700_000_000, 'preprod', 0, CURSOR))
    const read = await run(loadDustStateForSpend(GROUP, ACCOUNT, 'preprod'))
    expect(read?.blockTimeSecs).toBe(0)
  })

  it('is undefined when nothing is stored, so "unsynced" cannot read as "no block time"', async () => {
    expect(await run(loadDustStateForSpend(GROUP, ACCOUNT, 'preprod'))).toBeUndefined()
  })
})

describe('saveDustState', () => {
  const CURSOR = {nextGeneration: 7, nextCommitment: 9}

  it('writes the watermark only when it was given one', async () => {
    await run(saveDustState(GROUP, ACCOUNT, CONFIRMED, 1_700_000_000, 'preprod', 1_699_000_000, CURSOR))
    expect(disk.has(dustSyncedWatermarkKey(GROUP, ACCOUNT))).toBe(false)
    await run(saveDustState(GROUP, ACCOUNT, CONFIRMED, 1_700_000_000, 'preprod', 1_699_000_000, CURSOR, 42))
    expect(disk.get(dustSyncedWatermarkKey(GROUP, ACCOUNT))).toBe('42')
  })

  it('stamps the network and the block time alongside the state', async () => {
    await run(saveDustState(GROUP, ACCOUNT, CONFIRMED, 1_700_000_000, 'preprod', 1_699_000_000, CURSOR))
    expect(disk.get(dustNetworkKey(GROUP, ACCOUNT))).toBe('preprod')
    expect(disk.get(dustBlockTimeKey(GROUP, ACCOUNT))).toBe('1699000000')
    expect(disk.get(dustSyncedAtKey(GROUP, ACCOUNT))).toBe('1700000000')
  })

  // ⚠️ The cursor is what makes the *next* sync an advance rather than a rebuild, and a rebuild is
  // refused for a wallet that has spent DUST. A state stored without one is a wallet that can only be
  // repaired by a path that does not exist yet.
  it('writes the tree cursor, so the next sync can resume instead of rebuilding', async () => {
    await run(saveDustState(GROUP, ACCOUNT, CONFIRMED, 1_700_000_000, 'preprod', 1_699_000_000, CURSOR))
    expect(disk.get(dustCursorKey(GROUP, ACCOUNT))).toBe('7:9')
    expect(await run(loadDustCursor(GROUP, ACCOUNT))).toEqual(CURSOR)
  })

  it('reads an unreadable cursor as absent, never as zero', async () => {
    // Resuming from 0 against a filled tree inserts at the wrong index; the ledger refuses it, but only
    // later and with an error about the tree rather than about the cursor.
    disk.set(dustCursorKey(GROUP, ACCOUNT), 'not:a:cursor')
    expect(await run(loadDustCursor(GROUP, ACCOUNT))).toBeUndefined()
  })
})

describe('when storage itself fails', () => {
  it('says so rather than reporting no state — the two are different facts', async () => {
    disk.set(dustNetworkKey(GROUP, ACCOUNT), 'preprod')
    failOn = dustStateKey(GROUP, ACCOUNT)
    const outcome = await runEither(loadConfirmedDustState(GROUP, ACCOUNT, 'preprod'))
    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) {
      expect(outcome.left._tag).toBe('DustStoreError')
      expect(outcome.left.reason).toMatch(/mmkv refused the read/)
    }
  })

  it('never fails markDustSpent, because the send it follows has already landed', async () => {
    failOn = dustSpentKey(GROUP, ACCOUNT)
    // A rejection here would report a completed send as failed. The cost of the lost flag is a later
    // fast sync that should have been refused, which is why the store logs it at `error` instead.
    await expect(run(markDustSpent(GROUP, ACCOUNT))).resolves.toBeUndefined()
  })
})
