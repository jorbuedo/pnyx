import {Effect, Either} from 'effect'
import {describe, expect, it, vi} from 'vitest'

const backing = new Map<string, string>()

vi.mock('../../../platform/storage', () => ({
  storage: {
    get: async (key: string) => backing.get(key) ?? null,
    set: async (key: string, value: string) => {
      backing.set(key, String(value))
    },
    getSync: (key: string) => backing.get(key) ?? null,
  },
}))

vi.mock('../../../logger', () => ({logger: {warn: vi.fn(), info: vi.fn(), debug: vi.fn()}}))

const {
  loadShieldedBirthday,
  loadShieldedCursor,
  loadShieldedState,
  parseStoredBirthday,
  parseStoredCursor,
  parseStoredState,
  saveShieldedBirthday,
  saveShieldedCursor,
  saveShieldedState,
  shieldedBirthdayKey,
  shieldedCursorKey,
  shieldedStateKey,
} = await import('./state-store')

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect)
const runEither = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(Effect.either(effect))

describe('keys', () => {
  it('scopes state and cursor by group and account, so two groups cannot share coins', () => {
    expect(shieldedStateKey('g1', 0)).not.toBe(shieldedStateKey('g2', 0))
    expect(shieldedStateKey('g1', 0)).not.toBe(shieldedStateKey('g1', 1))
    // Distinct prefixes: a cursor must never be read as a state, since the state is the money.
    expect(shieldedCursorKey('g1', 0)).not.toBe(shieldedStateKey('g1', 0))
  })
})

describe('parseStoredState', () => {
  it('reads absent storage as "no wallet yet"', async () => {
    expect(await run(parseStoredState(null))).toBeUndefined()
    expect(await run(parseStoredState(''))).toBeUndefined()
  })

  it('round-trips a state', async () => {
    const state = new Uint8Array([0, 1, 2, 250, 255])
    await run(saveShieldedState('g1', 0, state, 'preprod'))
    expect(Array.from((await run(loadShieldedState('g1', 0, 'preprod'))) ?? [])).toEqual([0, 1, 2, 250, 255])
  })

  it('refuses unreadable bytes rather than reporting an empty wallet', async () => {
    // The load-bearing case: a coin taken with insertCoin exists nowhere else, so replacing a corrupt
    // blob with a fresh state would destroy it and show a zero balance as though it were the truth.
    for (const raw of ['not-hex', 'abc']) {
      const outcome = await runEither(parseStoredState(raw))
      expect(Either.isLeft(outcome)).toBe(true)
      if (Either.isLeft(outcome)) {
        // `unreadable`, not `storage`: the read happened and the bytes are wrong, which is the one
        // case nothing may recover from by writing a fresh state.
        expect(outcome.left.cause).toBe('unreadable')
        expect(outcome.left.reason).toMatch(/refusing to overwrite/)
      }
    }
  })

  it('carries that refusal out through loadShieldedState', async () => {
    backing.set(shieldedStateKey('g-corrupt', 0), 'not-hex')
    const outcome = await runEither(loadShieldedState('g-corrupt', 0, 'preprod'))
    expect(Either.isLeft(outcome)).toBe(true)
    if (Either.isLeft(outcome)) expect(outcome.left.cause).toBe('unreadable')
  })
})

describe('parseStoredCursor', () => {
  it('reads a height', () => {
    expect(parseStoredCursor('2171630')).toBe(2171630)
  })

  it.each([
    ['', undefined],
    [null, undefined],
    ['0', undefined],
    ['-5', undefined],
    ['abc', undefined],
  ] as const)('reads %p as absent rather than as a height', (raw, expected) => {
    expect(parseStoredCursor(raw)).toBe(expected)
  })

  it('round-trips through storage', async () => {
    await run(saveShieldedState('g1', 0, new Uint8Array([1]), 'preprod'))
    await run(saveShieldedCursor('g1', 0, 12_345))
    expect(await run(loadShieldedCursor('g1', 0, 'preprod'))).toBe(12_345)
  })

  it('keeps the cursor and the state independent', async () => {
    await run(saveShieldedState('g9', 2, new Uint8Array([7, 7]), 'preprod'))
    // No cursor written for that pair: a wallet with coins and no cursor must rescan, not read the
    // state as absent.
    expect(await run(loadShieldedCursor('g9', 2, 'preprod'))).toBeUndefined()
    expect((await run(loadShieldedState('g9', 2, 'preprod')))?.length).toBe(2)
  })

  it('reports none for a cursor left behind by another network', async () => {
    // Measured on a device 2026-09-14: a wallet scanned to preview 734,956, switched to preprod, and
    // the screen read "1,808,548 blocks behind the chain" — preprod's tip minus a preview height. The
    // sync would have resumed there too, with no collapse, applying preprod blocks to a blank tree.
    await run(saveShieldedState('g-switch', 0, new Uint8Array([3]), 'preview'))
    await run(saveShieldedCursor('g-switch', 0, 734_956))
    expect(await run(loadShieldedCursor('g-switch', 0, 'preview'))).toBe(734_956)
    expect(await run(loadShieldedCursor('g-switch', 0, 'preprod'))).toBeUndefined()
  })

  it('reads a cursor whose state predates the network stamp', async () => {
    // Unstamped is "unknown", not "another network": the state is returned in that case, so the
    // cursor counting its blocks must be too, or a wallet that never switched would rescan for ever.
    backing.set(shieldedCursorKey('g-legacy', 0), '2171630')
    expect(await run(loadShieldedCursor('g-legacy', 0, 'preprod'))).toBe(2_171_630)
  })
})

describe('the shielded birthday', () => {
  it('is keyed by network, not by account — a height means nothing on another chain', () => {
    expect(shieldedBirthdayKey('g1', 'preprod')).not.toBe(shieldedBirthdayKey('g1', 'preview'))
    expect(shieldedBirthdayKey('g1', 'preprod')).not.toBe(shieldedBirthdayKey('g2', 'preprod'))
    // And never confusable with the cursor, which is a height under the same group.
    expect(shieldedBirthdayKey('g1', 'preprod')).not.toBe(shieldedCursorKey('g1', 0))
  })

  it('reads a record back', () => {
    expect(parseStoredBirthday('{"height":2534136,"origin":"created"}')).toEqual({
      height: 2_534_136,
      origin: 'created',
    })
  })

  it.each([
    ['absent', null],
    ['empty', ''],
    ['not json', 'nonsense'],
    ['not an object', '42'],
    ['height missing', '{"origin":"created"}'],
    ['height zero — not a block', '{"height":0,"origin":"created"}'],
    ['height fractional', '{"height":12.5,"origin":"created"}'],
    ['origin unknown', '{"height":10,"origin":"guessed"}'],
  ])('treats a %s record as no birthday rather than a weaker one', (_why, raw) => {
    // A guessed birthday would be reported to the user as a complete history. Absent is the honest
    // answer, and it costs a bounded tip-window sync rather than anything irreversible.
    expect(parseStoredBirthday(raw)).toBeUndefined()
  })

  it('records one, and reads it back under its own key', async () => {
    await run(saveShieldedBirthday('g-new', 'preprod', {height: 2_534_136, origin: 'created'}))
    expect(await run(loadShieldedBirthday('g-new', 'preprod'))).toEqual({height: 2_534_136, origin: 'created'})
    // Another network under the same group is a separate answer, not the same one.
    expect(await run(loadShieldedBirthday('g-new', 'preview'))).toBeUndefined()
  })

  it('never moves a birthday later', async () => {
    // ⚠️ The rule the whole record depends on. A later height skips the blocks between the two —
    // silently and permanently, since nothing rescans a range the cursor has passed.
    await run(saveShieldedBirthday('g-mono', 'preprod', {height: 100, origin: 'created'}))
    await run(saveShieldedBirthday('g-mono', 'preprod', {height: 900, origin: 'recovered'}))
    expect(await run(loadShieldedBirthday('g-mono', 'preprod'))).toEqual({height: 100, origin: 'created'})
  })

  it('does move a birthday earlier', async () => {
    // A recovery blob arriving after a local stamp knows the real one. Scanning more is always safe.
    await run(saveShieldedBirthday('g-earlier', 'preprod', {height: 900, origin: 'created'}))
    await run(saveShieldedBirthday('g-earlier', 'preprod', {height: 100, origin: 'recovered'}))
    expect(await run(loadShieldedBirthday('g-earlier', 'preprod'))).toEqual({height: 100, origin: 'recovered'})
  })
})
