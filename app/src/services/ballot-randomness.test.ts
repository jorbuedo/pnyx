import {beforeEach, describe, expect, it, vi} from 'vitest'
import {ballotRandomnessFor, storedBallotRandomness} from './ballot-randomness'

const store = new Map<string, string>()

vi.mock('../platform/storage', () => ({
  storage: {
    get: async (key: string) => store.get(key) ?? null,
    set: async (key: string, value: string) => {
      store.set(key, value)
    },
  },
}))

const errors: string[] = []
vi.mock('../logger', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: (message: string) => {
      errors.push(message)
    },
  },
}))

const PROPOSAL = 'ab'.repeat(32)

beforeEach(() => {
  store.clear()
  errors.length = 0
})

describe('ballotRandomnessFor', () => {
  it('mints 32 bytes on first use and persists them', async () => {
    const minted = await ballotRandomnessFor('preprod', PROPOSAL)
    expect(minted).toHaveLength(32)
    expect(store.get(`pnyx:ballot:preprod:${PROPOSAL}`)).toBe(
      Array.from(minted, (b) => b.toString(16).padStart(2, '0')).join(''),
    )
  })

  it('returns the same value on a retry, so a re-cast commits under the same randomness', async () => {
    const first = await ballotRandomnessFor('preprod', PROPOSAL)
    const second = await ballotRandomnessFor('preprod', PROPOSAL)
    expect(second).toEqual(first)
  })

  it('keeps proposals and networks apart', async () => {
    const a = await ballotRandomnessFor('preprod', PROPOSAL)
    const b = await ballotRandomnessFor('preprod', 'cd'.repeat(32))
    const c = await ballotRandomnessFor('preview', PROPOSAL)
    expect(a).not.toEqual(b)
    expect(a).not.toEqual(c)
  })

  it('refuses rather than overwriting a stored value it cannot read', async () => {
    // Overwriting would strand whatever commit that value was made under, permanently.
    store.set(`pnyx:ballot:preprod:${PROPOSAL}`, 'not-hex')
    await expect(ballotRandomnessFor('preprod', PROPOSAL)).rejects.toThrow(/unreadable ballot randomness/)
    expect(store.get(`pnyx:ballot:preprod:${PROPOSAL}`)).toBe('not-hex')
    expect(errors).toHaveLength(1)
  })

  it('refuses a stored value of the wrong length', async () => {
    store.set(`pnyx:ballot:preprod:${PROPOSAL}`, 'abcd')
    await expect(ballotRandomnessFor('preprod', PROPOSAL)).rejects.toThrow()
  })
})

describe('storedBallotRandomness', () => {
  it('never mints — a reveal with fresh randomness would fail the commit check in-circuit', async () => {
    await expect(storedBallotRandomness('preprod', PROPOSAL)).resolves.toBeUndefined()
    expect(store.size).toBe(0)
  })

  it('returns exactly what the cast committed under', async () => {
    const cast = await ballotRandomnessFor('preprod', PROPOSAL)
    await expect(storedBallotRandomness('preprod', PROPOSAL)).resolves.toEqual(cast)
  })

  it('reports an unreadable value as absent, and says so', async () => {
    store.set(`pnyx:ballot:preprod:${PROPOSAL}`, 'zz')
    await expect(storedBallotRandomness('preprod', PROPOSAL)).resolves.toBeUndefined()
    expect(errors).toHaveLength(1)
  })
})
