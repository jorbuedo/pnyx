import {beforeEach, describe, expect, it, vi} from 'vitest'

vi.mock('../../../logger', () => ({logger: {debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn()}}))
vi.mock('../../store-change', () => ({notifyStoreChange: vi.fn(), onStoreChange: () => () => undefined}))

/**
 * MMKV is synchronous, but our wrapper is a Promise — and a Promise is exactly what lets two
 * read-modify-writes interleave. The delay makes that window deterministic instead of accidental.
 */
const disk = new Map<string, string>()
const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

vi.mock('../../../platform/storage', () => ({
  storage: {
    get: async (key: string) => {
      await tick()
      return disk.get(key) ?? null
    },
    set: async (key: string, value: string) => {
      await tick()
      disk.set(key, value)
    },
    remove: async (key: string) => {
      disk.delete(key)
    },
  },
}))

const {loadPendingSends, pendingSendKey, recordPendingSend, removePendingSends, savePendingSends} = await import(
  './pending-send-store'
)

const GROUP = 'group-a'
const send = (id: string) => ({
  identifiers: [id],
  rail: 'unshielded' as const,
  direction: 'sent' as const,
  tokenType: '00',
  amount: 1n,
  recipient: 'mn_addr_preprod1them',
  // ⚠️ Now, not a fixed date. `loadPendingSends` sweeps rows past `PENDING_SEND_TTL_MS`, so a pinned
  // timestamp silently ages out of the window and these tests stop exercising the race they are for.
  submittedAt: new Date().toISOString(),
})

beforeEach(() => {
  disk.clear()
})

describe('a send recorded while another settles', () => {
  it('survives — settling removes what it names rather than writing back the rest', async () => {
    // ⚠️ The defect this pins, found by an audit pass. Both writers are load-then-save. Settling used
    // to write back `stillPending`, computed from a read taken *before* the new send existed — so the
    // new row vanished: invisible on screen, its unshielded locks held to their one-hour TTL, its
    // pending DUST spend never promoted. Settling now happens on every transaction the live feed sees,
    // so the window is open continuously rather than once per manual sync.
    await savePendingSends(GROUP, 0, [send('older')])

    await Promise.all([removePendingSends(GROUP, 0, [['older']]), recordPendingSend(GROUP, 0, send('newer'))])

    const left = await loadPendingSends(GROUP, 0)
    expect(left.map((s) => s.identifiers[0])).toEqual(['newer'])
  })

  it('two sends recorded at once both survive', async () => {
    await Promise.all([recordPendingSend(GROUP, 0, send('a')), recordPendingSend(GROUP, 0, send('b'))])
    const left = await loadPendingSends(GROUP, 0)
    expect(left.map((s) => s.identifiers[0]).sort()).toEqual(['a', 'b'])
  })
})

describe('removePendingSends', () => {
  it('matches by containment, because a sponsored transaction lands with extra identifiers', async () => {
    await savePendingSends(GROUP, 0, [send('ours')])
    await removePendingSends(GROUP, 0, [['sponsor', 'ours', 'other']])
    expect(await loadPendingSends(GROUP, 0)).toEqual([])
  })

  it('leaves a send whose identifiers did not all land', async () => {
    await savePendingSends(GROUP, 0, [{...send('ours'), identifiers: ['ours', 'second']}])
    await removePendingSends(GROUP, 0, [['ours']])
    expect((await loadPendingSends(GROUP, 0)).length).toBe(1)
  })

  it('writes nothing when it removes nothing', async () => {
    await savePendingSends(GROUP, 0, [send('ours')])
    const before = disk.get(pendingSendKey(GROUP, 0))
    await removePendingSends(GROUP, 0, [['someone-else']])
    expect(disk.get(pendingSendKey(GROUP, 0))).toBe(before)
  })
})
