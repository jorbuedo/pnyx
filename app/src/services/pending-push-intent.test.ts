import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'
import {
  __resetPendingPushIntentForTests,
  consumeOverwrittenTxIdIfPresent,
  pendingPushIntent,
} from './pending-push-intent'

vi.mock('../logger', () => ({
  logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()},
}))

// Mock platform/storage so the persistence layer doesn't pull in
// react-native-mmkv (native module unavailable under vitest). Disk
// survival is verified in dedicated tests if needed; here we keep the
// in-memory contract identical to pre-persistence behaviour.
vi.mock('../platform/storage', () => ({
  storage: {
    getSync: vi.fn(() => null),
    get: vi.fn(async () => null),
    set: vi.fn(async () => undefined),
    remove: vi.fn(async () => undefined),
  },
}))

const FIXED_NOW = 1_700_000_000_000

beforeEach(() => {
  __resetPendingPushIntentForTests()
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('pendingPushIntent', () => {
  it('set then peek returns the intent without clearing', () => {
    pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
    expect(pendingPushIntent.peek()).toEqual({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
    expect(pendingPushIntent.peek()).toEqual({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
  })

  it('consume returns the intent and clears storage', () => {
    pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
    expect(pendingPushIntent.consume()).toEqual({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
    expect(pendingPushIntent.peek()).toBeNull()
    expect(pendingPushIntent.consume()).toBeNull()
  })

  it('peek returns null and clears when the intent has expired', () => {
    pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
    vi.setSystemTime(FIXED_NOW + 6 * 60_000)
    expect(pendingPushIntent.peek()).toBeNull()
    vi.setSystemTime(FIXED_NOW)
    expect(pendingPushIntent.peek()).toBeNull()
  })

  it('consume returns null when expired and does not re-emit a stale value', () => {
    pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
    vi.setSystemTime(FIXED_NOW + 5 * 60_000 + 1)
    expect(pendingPushIntent.consume()).toBeNull()
    expect(pendingPushIntent.peek()).toBeNull()
  })

  it('overwrite replaces the previous intent and notifies subscribers', () => {
    const seen: Array<unknown> = []
    pendingPushIntent.subscribe((v) => seen.push(v))
    pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
    pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-2', createdAtMs: FIXED_NOW + 1_000})
    expect(pendingPushIntent.peek()).toEqual({kind: 'card-3ds', txId: 'tx-2', createdAtMs: FIXED_NOW + 1_000})
    expect(seen).toHaveLength(2)
  })

  it('clear empties the store and notifies subscribers', () => {
    const seen: Array<unknown> = []
    pendingPushIntent.subscribe((v) => seen.push(v))
    pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
    pendingPushIntent.clear()
    expect(pendingPushIntent.peek()).toBeNull()
    expect(seen).toEqual([{kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW}, null])
  })

  it('clear on an empty store does not notify', () => {
    const fn = vi.fn()
    pendingPushIntent.subscribe(fn)
    pendingPushIntent.clear()
    expect(fn).not.toHaveBeenCalled()
  })

  it('subscribe + unsubscribe stops emissions', () => {
    const fn = vi.fn()
    const unsubscribe = pendingPushIntent.subscribe(fn)
    pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
    expect(fn).toHaveBeenCalledTimes(1)
    unsubscribe()
    pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-2', createdAtMs: FIXED_NOW})
    expect(fn).toHaveBeenCalledTimes(1)
  })

  describe('card-3ds optional userAddress + cardId fields', () => {
    const EOA = '0x1234567890abcdef1234567890abcdef12345678'
    const CID = 'card-abc-123'

    it('round-trips the optional userAddress and cardId fields', () => {
      pendingPushIntent.set({
        kind: 'card-3ds',
        txId: 'tx-multi',
        createdAtMs: FIXED_NOW,
        userAddress: EOA,
        cardId: CID,
      })
      expect(pendingPushIntent.peek()).toEqual({
        kind: 'card-3ds',
        txId: 'tx-multi',
        createdAtMs: FIXED_NOW,
        userAddress: EOA,
        cardId: CID,
      })
    })

    it('older intents without the optional fields still validate (back-compat)', () => {
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-legacy', createdAtMs: FIXED_NOW})
      expect(pendingPushIntent.peek()).toEqual({kind: 'card-3ds', txId: 'tx-legacy', createdAtMs: FIXED_NOW})
    })

    it('accepts userAddress alone (cardId absent)', () => {
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-eoa-only', createdAtMs: FIXED_NOW, userAddress: EOA})
      const peeked = pendingPushIntent.peek()
      expect(peeked).toEqual({kind: 'card-3ds', txId: 'tx-eoa-only', createdAtMs: FIXED_NOW, userAddress: EOA})
      expect(peeked).not.toHaveProperty('cardId')
    })

    it('accepts cardId alone (userAddress absent)', () => {
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-card-only', createdAtMs: FIXED_NOW, cardId: CID})
      const peeked = pendingPushIntent.peek()
      expect(peeked).toEqual({kind: 'card-3ds', txId: 'tx-card-only', createdAtMs: FIXED_NOW, cardId: CID})
      expect(peeked).not.toHaveProperty('userAddress')
    })
  })

  it('a throwing subscriber does not block others', () => {
    const ok = vi.fn()
    pendingPushIntent.subscribe(() => {
      throw new Error('boom')
    })
    pendingPushIntent.subscribe(ok)
    pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
    expect(ok).toHaveBeenCalledTimes(1)
  })

  it('expired intent emits a null notification on TTL drop via peek', () => {
    const fn = vi.fn()
    pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
    pendingPushIntent.subscribe(fn)
    vi.setSystemTime(FIXED_NOW + 5 * 60_000 + 1)
    expect(pendingPushIntent.peek()).toBeNull()
    expect(fn).toHaveBeenCalledWith(null)
  })

  describe('override-attempted tracking (prompt-loop guard)', () => {
    it('hasOverrideBeenAttempted defaults false', () => {
      expect(pendingPushIntent.hasOverrideBeenAttempted('tx-1')).toBe(false)
    })

    it('markOverrideAttempted sets the flag', () => {
      pendingPushIntent.markOverrideAttempted('tx-1')
      expect(pendingPushIntent.hasOverrideBeenAttempted('tx-1')).toBe(true)
      expect(pendingPushIntent.hasOverrideBeenAttempted('tx-other')).toBe(false)
    })

    it('consume clears all override-attempted txIds', () => {
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
      pendingPushIntent.markOverrideAttempted('tx-1')
      pendingPushIntent.consume()
      expect(pendingPushIntent.hasOverrideBeenAttempted('tx-1')).toBe(false)
    })

    it('clear clears all override-attempted txIds', () => {
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
      pendingPushIntent.markOverrideAttempted('tx-1')
      pendingPushIntent.clear()
      expect(pendingPushIntent.hasOverrideBeenAttempted('tx-1')).toBe(false)
    })

    it('TTL drop clears all override-attempted txIds', () => {
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
      pendingPushIntent.markOverrideAttempted('tx-1')
      vi.setSystemTime(FIXED_NOW + 5 * 60_000 + 1)
      pendingPushIntent.peek()
      expect(pendingPushIntent.hasOverrideBeenAttempted('tx-1')).toBe(false)
    })

    it('overwriting with a new identity clears override-attempted', () => {
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
      pendingPushIntent.markOverrideAttempted('tx-1')
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-2', createdAtMs: FIXED_NOW + 1_000})
      expect(pendingPushIntent.hasOverrideBeenAttempted('tx-1')).toBe(false)
    })

    it('idempotent re-set with same identity preserves override-attempted', () => {
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
      pendingPushIntent.markOverrideAttempted('tx-1')
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW + 1_000})
      expect(pendingPushIntent.hasOverrideBeenAttempted('tx-1')).toBe(true)
    })
  })

  describe('overwrite recovery tracking', () => {
    it('returns null when txId was never overwritten', () => {
      expect(consumeOverwrittenTxIdIfPresent('tx-never')).toBeNull()
    })

    it('records the orphaned txId on a state-loss overwrite and exposes it once', () => {
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-old', createdAtMs: FIXED_NOW})
      vi.setSystemTime(FIXED_NOW + 1_000)
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-new', createdAtMs: FIXED_NOW + 1_000})
      const overwriteAt = consumeOverwrittenTxIdIfPresent('tx-old')
      // overwriteAt is the wall-clock moment of the overwrite, not the new
      // intent's createdAtMs (the recovery signal cares about how long
      // the orphan has been waiting, not who replaced it).
      expect(overwriteAt).toBe(FIXED_NOW + 1_000)
      // Second consume returns null (the entry is single-shot).
      expect(consumeOverwrittenTxIdIfPresent('tx-old')).toBeNull()
    })

    it('returns null after the 5-min recovery window elapses', () => {
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-old', createdAtMs: FIXED_NOW})
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-new', createdAtMs: FIXED_NOW + 1_000})
      vi.setSystemTime(FIXED_NOW + 5 * 60_000 + 1) // past 5-min deadline
      expect(consumeOverwrittenTxIdIfPresent('tx-old')).toBeNull()
    })

    it('does not record non-overwrite replacements (different kind / matching id)', () => {
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW})
      // Same id = idempotent, not a state-loss
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-1', createdAtMs: FIXED_NOW + 1_000})
      expect(consumeOverwrittenTxIdIfPresent('tx-1')).toBeNull()
    })

    it('sweeps stale entries on subsequent overwrite', () => {
      // First overwrite — records tx-stale's orphan at FIXED_NOW.
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-stale', createdAtMs: FIXED_NOW})
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-current', createdAtMs: FIXED_NOW + 1_000})
      // Advance well past the 5-min recovery window before the next overwrite.
      const tLate = FIXED_NOW + 10 * 60_000
      vi.setSystemTime(tLate)
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-fresh', createdAtMs: tLate})
      // The second `set` sweeps tx-stale (deadline elapsed) before recording
      // tx-current's orphan.
      expect(consumeOverwrittenTxIdIfPresent('tx-stale')).toBeNull()
      expect(consumeOverwrittenTxIdIfPresent('tx-current')).toBe(tLate)
    })

    it('test-reset clears the overwrite tracking', () => {
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-old', createdAtMs: FIXED_NOW})
      pendingPushIntent.set({kind: 'card-3ds', txId: 'tx-new', createdAtMs: FIXED_NOW + 1_000})
      __resetPendingPushIntentForTests()
      expect(consumeOverwrittenTxIdIfPresent('tx-old')).toBeNull()
    })
  })
})
