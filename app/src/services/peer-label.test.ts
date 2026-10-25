import {encodeDisplayName, encodeHandle, NO_HANDLE} from '@pnyx/contract-client/handle'
import type {HandleValidity} from '@pnyx/contract-client/handle-validity'
import {hex} from '@pnyx/crypto'
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

const resolveIdentityRow = vi.fn()
vi.mock('./identity-row', () => ({resolveIdentityRow: (id: string) => resolveIdentityRow(id)}))

// One contract per identity, so a peer's address *is* the cache key. Derived from the id here so a
// test can name the same address the module will.
const identityAddressOf = (pnyxId: string): string => hex.encode(new TextEncoder().encode(pnyxId))
vi.mock('./identity-contract', () => ({
  identityContractAddressForPnyxId: async (id: string) => new TextEncoder().encode(id),
}))

/** The handle contract a verified verdict rests on — a second address, with a height of its own. */
const HANDLE_ADDRESS = 'ab'.repeat(32)

// Heights the state cache is holding. Unset addresses answer 1, which is the state every test starts
// from; a test that needs a contract to have moved (or to be uncached) sets it explicitly.
let heights: Map<string, number | undefined>
vi.mock('./pnyx-contract-state', () => ({
  contractStateGenerationAt: (address: string) => (heights.has(address) ? heights.get(address) : 1),
}))

const verifyRowName = vi.fn()
vi.mock('./handle-resolve', () => ({verifyRowName: (id: string, name: Uint8Array) => verifyRowName(id, name)}))

const {peerHandleFor, peerNicknameFor, knownPeerHandle, knownPeerNickname, forgetPeerHandle, resetPeerLabelCache} =
  await import('./peer-label')

const row = (name: Uint8Array) => ({kind: 'row', row: {anchor: new Uint8Array(32), authPub: new Uint8Array(32), name}})

/** A verdict as `verifyRowName` returns it: the validity, plus the contract it was read from. */
const verdict = (validity: HandleValidity, source: {address: string; height: number | undefined} | undefined) => ({
  validity,
  source,
})
const agrees = (display: string) => verdict({kind: 'valid', display}, {address: HANDLE_ADDRESS, height: 1})

const reset = () => {
  resolveIdentityRow.mockReset()
  verifyRowName.mockReset()
  resetPeerLabelCache()
  heights = new Map()
}

describe('peerHandleFor', () => {
  beforeEach(reset)

  it('renders the name when the row and the handle contract agree', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('alice'))
    expect(await peerHandleFor('pnyx_id_x')).toBe('alice')
  })

  // ⚠️ The reason this module consults a second contract at all. `primaryName` is a row its owner
  // writes, so a hostile client can put somebody else's name in it; only `handle(name).owner` says
  // whose the name is. Drawing the row's claim here is impersonation, not a cosmetic bug.
  it('refuses a name the handle contract says belongs to someone else', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(verdict({kind: 'other-owner'}, {address: HANDLE_ADDRESS, height: 1}))
    expect(await peerHandleFor('pnyx_id_impostor')).toBeUndefined()
  })

  it.each([
    ['unbound', {kind: 'unbound'} as const],
    ['not-displayed', {kind: 'not-displayed'} as const],
    ['banned', {kind: 'banned'} as const],
    ['burned', {kind: 'burned'} as const],
    ['unrenderable', {kind: 'unrenderable', reason: 'not-canonical'} as const],
  ])('draws nothing for a %s verdict', async (_name, validity) => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(verdict(validity, {address: HANDLE_ADDRESS, height: 1}))
    expect(await peerHandleFor(`pnyx_id_${validity.kind}`)).toBeUndefined()
  })

  it('has no handle when the row claims none, and asks no contract about it', async () => {
    resolveIdentityRow.mockResolvedValue(row(NO_HANDLE))
    expect(await peerHandleFor('pnyx_id_x')).toBeUndefined()
    expect(verifyRowName).not.toHaveBeenCalled()
  })

  it('renders the spelling its owner chose, case and all', async () => {
    // Case stopped being a canonicality rule on 2026-08-24: `handle(name)` derives its address from the
    // folded form, so `ALICE` and `alice` are one name, and the verdict carries which case to draw.
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('ALICE'))
    expect(await peerHandleFor('pnyx_id_upper')).toBe('ALICE')
  })

  it('falls back to the id when the row cannot be read', async () => {
    resolveIdentityRow.mockResolvedValue({kind: 'unavailable'})
    expect(await peerHandleFor('pnyx_id_out')).toBeUndefined()
    resolveIdentityRow.mockResolvedValue({kind: 'unpublished'})
    expect(await peerHandleFor('pnyx_id_none')).toBeUndefined()
  })

  // A throw here would take the whole conversation list down with it, for a label.
  it('never rejects, whatever the lookup does', async () => {
    resolveIdentityRow.mockRejectedValue(new Error('indexer down'))
    await expect(peerHandleFor('pnyx_id_x')).resolves.toBeUndefined()
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockRejectedValue(new Error('handle contract unreachable'))
    await expect(peerHandleFor('pnyx_id_y')).resolves.toBeUndefined()
  })
})

describe('the memo', () => {
  beforeEach(reset)

  it('resolves a peer once and answers the rest from memory', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('alice'))
    expect(await peerHandleFor('pnyx_id_a')).toBe('alice')
    expect(await peerHandleFor('pnyx_id_a')).toBe('alice')
    expect(await peerHandleFor('pnyx_id_a')).toBe('alice')
    expect(resolveIdentityRow).toHaveBeenCalledTimes(1)
    expect(verifyRowName).toHaveBeenCalledTimes(1)
  })

  // "This peer has no name" is the common case, and re-deriving it every mount is the whole cost.
  it('remembers the absence of a handle too', async () => {
    resolveIdentityRow.mockResolvedValue(row(NO_HANDLE))
    expect(await peerHandleFor('pnyx_id_b')).toBeUndefined()
    expect(await peerHandleFor('pnyx_id_b')).toBeUndefined()
    expect(resolveIdentityRow).toHaveBeenCalledTimes(1)
  })

  it('retires a peer’s entry when their own identity contract moves', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('alice'))
    expect(await peerHandleFor('pnyx_id_c')).toBe('alice')

    heights.set(identityAddressOf('pnyx_id_c'), 2)
    verifyRowName.mockResolvedValue(agrees('alicerenamed'))
    expect(await peerHandleFor('pnyx_id_c')).toBe('alicerenamed')
    expect(resolveIdentityRow).toHaveBeenCalledTimes(2)
  })

  // ⚠️ The bug a single global generation caused. There is one identity contract *per identity*, so
  // reading peer B changed the height the whole memo was keyed on and evicted peer A — leaving a cache
  // that never held more than the most recent peer, which is the one case it was built for.
  it('keys each peer on their own contract, so reading one does not retire another', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('alice'))
    expect(await peerHandleFor('pnyx_id_first')).toBe('alice')

    heights.set(identityAddressOf('pnyx_id_second'), 999)
    verifyRowName.mockResolvedValue(agrees('bob'))
    expect(await peerHandleFor('pnyx_id_second')).toBe('bob')

    expect(knownPeerHandle('pnyx_id_first')).toBe('alice')
    expect(resolveIdentityRow).toHaveBeenCalledTimes(2)
  })

  // The axis no identity height can cover: a ban or a burn moves the *handle* contract and nothing else.
  it('retires a verdict when the handle contract behind it moves', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('alice'))
    expect(await peerHandleFor('pnyx_id_banned')).toBe('alice')

    heights.set(HANDLE_ADDRESS, 2)
    expect(knownPeerHandle('pnyx_id_banned')).toBeNull()
    verifyRowName.mockResolvedValue(verdict({kind: 'banned'}, {address: HANDLE_ADDRESS, height: 2}))
    expect(await peerHandleFor('pnyx_id_banned')).toBeUndefined()
  })

  // An outage must not outlive itself: caching the fallback would pin "no name" until the contract
  // next moved, which on a quiet chain is indefinitely.
  it('never memoises a read it could not make', async () => {
    resolveIdentityRow.mockResolvedValue({kind: 'unavailable'})
    expect(await peerHandleFor('pnyx_id_d')).toBeUndefined()
    expect(knownPeerHandle('pnyx_id_d')).toBeNull()

    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('alice'))
    expect(await peerHandleFor('pnyx_id_d')).toBe('alice')
  })

  // Same rule, one layer down: the row read fine and the *handle* contract did not.
  it('never memoises a verdict it could not verify', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(verdict({kind: 'unrenderable', reason: 'unverifiable'}, undefined))
    expect(await peerHandleFor('pnyx_id_e')).toBeUndefined()
    expect(knownPeerHandle('pnyx_id_e')).toBeNull()
  })

  // What a poll needs. Without it a loop calling `peerHandleFor` re-reads its own first answer until
  // it times out, because a memo hit moves no height — a landed write reported as a timeout.
  it('asks again after a peer is forgotten', async () => {
    resolveIdentityRow.mockResolvedValue(row(NO_HANDLE))
    expect(await peerHandleFor('pnyx_id_poll')).toBeUndefined()

    forgetPeerHandle('pnyx_id_poll')
    expect(knownPeerHandle('pnyx_id_poll')).toBeNull()
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('alice'))
    expect(await peerHandleFor('pnyx_id_poll')).toBe('alice')
    expect(resolveIdentityRow).toHaveBeenCalledTimes(2)
  })

  it('caches nothing while no state is held for the peer’s own contract', async () => {
    heights.set(identityAddressOf('pnyx_id_f'), undefined)
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('alice'))
    expect(await peerHandleFor('pnyx_id_f')).toBe('alice')
    expect(await peerHandleFor('pnyx_id_f')).toBe('alice')
    expect(resolveIdentityRow).toHaveBeenCalledTimes(2)
  })
})

describe('concurrent lookups', () => {
  beforeEach(reset)

  // The defect this closes: the DM thread screen resolved its peer through `usePeerHandles([peer])`
  // while the app-wide unread hook resolved the same peer, so the handle was verified twice, 37 ms
  // apart, with two separate fetches of `handle/manifest.json`. The memo could not prevent it —
  // it is written when a lookup finishes, and neither caller had finished.
  it('performs one read when two callers ask at once', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('alice'))

    const both = await Promise.all([peerHandleFor('pnyx_id_race'), peerHandleFor('pnyx_id_race')])

    expect(both).toEqual(['alice', 'alice'])
    expect(resolveIdentityRow).toHaveBeenCalledTimes(1)
    expect(verifyRowName).toHaveBeenCalledTimes(1)
  })

  it('reads again for the next caller once the shared lookup has settled', async () => {
    resolveIdentityRow.mockResolvedValue(row(NO_HANDLE))
    await Promise.all([peerHandleFor('pnyx_id_after'), peerHandleFor('pnyx_id_after')])
    expect(resolveIdentityRow).toHaveBeenCalledTimes(1)

    // The memo answers this one, which is what proves the in-flight entry was released rather than
    // left behind to answer for ever.
    forgetPeerHandle('pnyx_id_after')
    expect(await peerHandleFor('pnyx_id_after')).toBeUndefined()
    expect(resolveIdentityRow).toHaveBeenCalledTimes(2)
  })

  // ⚠️ Forgetting has to drop the in-flight entry too. Otherwise a poll that forgets mid-flight joins
  // the lookup that started *before* the write it is waiting for — the stale answer by a longer route.
  it('does not hand a forgotten peer the lookup that was already running', async () => {
    // Per call rather than a swapped mock: both lookups reach `resolveIdentityRow` only after their
    // first await, so a mock replaced in between is read by both. Ordering is what separates them —
    // the lookup started first gets the first answer.
    resolveIdentityRow.mockResolvedValueOnce(row(NO_HANDLE)).mockResolvedValueOnce(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('alice'))

    const first = peerHandleFor('pnyx_id_mid')
    forgetPeerHandle('pnyx_id_mid')
    const second = peerHandleFor('pnyx_id_mid')

    // Joining the running lookup would give both the same answer off one read.
    expect(await first).toBeUndefined()
    expect(await second).toBe('alice')
    expect(resolveIdentityRow).toHaveBeenCalledTimes(2)
  })

  it('keeps two different peers on their own lookups', async () => {
    resolveIdentityRow.mockResolvedValue(row(NO_HANDLE))
    await Promise.all([peerHandleFor('pnyx_id_one'), peerHandleFor('pnyx_id_two')])
    expect(resolveIdentityRow).toHaveBeenCalledTimes(2)
  })
})

describe('the verdict expiry', () => {
  beforeEach(() => {
    reset()
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // ⚠️ The reported bug: a peer claimed a handle mid-session and the app kept drawing their id. The
  // height check is exact but `contractStateGenerationAt` reports the *cached* height, and this memo is
  // what suppresses the read that would move it — so "no name" answered itself for ever.
  it('asks again once the height it trusts has gone unread for too long', async () => {
    resolveIdentityRow.mockResolvedValue(row(NO_HANDLE))
    expect(await peerHandleFor('pnyx_id_late')).toBeUndefined()
    expect(await peerHandleFor('pnyx_id_late')).toBeUndefined()
    expect(resolveIdentityRow).toHaveBeenCalledTimes(1)

    // The peer claims a name. Nothing re-read their contract, so the cached height has not moved.
    vi.setSystemTime(Date.now() + 5 * 60_000 + 1_000)
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('alice'))
    expect(await peerHandleFor('pnyx_id_late')).toBe('alice')
    expect(resolveIdentityRow).toHaveBeenCalledTimes(2)
  })

  it('still answers from memory within the bound, so a list does not re-read per row', async () => {
    resolveIdentityRow.mockResolvedValue(row(NO_HANDLE))
    expect(await peerHandleFor('pnyx_id_soon')).toBeUndefined()
    vi.setSystemTime(Date.now() + 2 * 60_000)
    expect(await peerHandleFor('pnyx_id_soon')).toBeUndefined()
    expect(resolveIdentityRow).toHaveBeenCalledTimes(1)
  })

  it('expires an answer that rested on a handle contract', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('alice'))
    expect(await peerHandleFor('pnyx_id_g')).toBe('alice')

    vi.advanceTimersByTime(9 * 60_000)
    expect(knownPeerHandle('pnyx_id_g')).toBe('alice')
    vi.advanceTimersByTime(2 * 60_000)
    expect(knownPeerHandle('pnyx_id_g')).toBeNull()
  })

  // Nothing expires an answer no handle contract took part in: the peer's own row is the only thing
  // that can change it, and their contract's height already says when it has.
  it('does not expire an answer no handle contract took part in', async () => {
    resolveIdentityRow.mockResolvedValue(row(NO_HANDLE))
    expect(await peerHandleFor('pnyx_id_h')).toBeUndefined()

    vi.advanceTimersByTime(60 * 60_000)
    expect(knownPeerHandle('pnyx_id_h')).toBeUndefined()
  })
})

describe('knownPeerHandle', () => {
  beforeEach(reset)

  // The distinction a render depends on: `null` means "ask", `undefined` means "asked, no name". A
  // caller that collapsed them would draw an id it is about to replace — the swap this exists to stop.
  it('separates not-yet-known from known-to-have-no-name', async () => {
    expect(knownPeerHandle('pnyx_id_i')).toBeNull()

    resolveIdentityRow.mockResolvedValue(row(NO_HANDLE))
    await peerHandleFor('pnyx_id_i')
    expect(knownPeerHandle('pnyx_id_i')).toBeUndefined()

    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('alice'))
    await peerHandleFor('pnyx_id_j')
    expect(knownPeerHandle('pnyx_id_j')).toBe('alice')
  })
})

// The nickname half. A row's name renders whether or not a handle contract backs it — the change that
// lets someone be seen without buying a permit first. `peerHandleFor` still answers only for a
// *registered* name, which is why every assertion here pairs the two.
describe('peerNicknameFor', () => {
  beforeEach(reset)
  afterEach(reset)

  it('returns the row name as a nickname when no handle backs it', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(verdict({kind: 'unbound'}, undefined))
    expect(await peerNicknameFor('pnyx_id_nick')).toBe('alice')
    expect(await peerHandleFor('pnyx_id_nick')).toBeUndefined()
  })

  it('keeps the spelling the owner chose rather than the folded form', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeDisplayName('Alice B')))
    verifyRowName.mockResolvedValue(verdict({kind: 'unbound'}, undefined))
    expect(await peerNicknameFor('pnyx_id_case')).toBe('Alice B')
  })

  it('returns both when a handle does back the name', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('Alice'))
    expect(await peerHandleFor('pnyx_id_both')).toBe('Alice')
    expect(await peerNicknameFor('pnyx_id_both')).toBe('alice')
  })

  // Moderation withholds the handle; it does not suppress the person's name.
  it('still shows the nickname for a banned name', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(verdict({kind: 'banned'}, {address: HANDLE_ADDRESS, height: 1}))
    expect(await peerNicknameFor('pnyx_id_banned_nick')).toBe('alice')
    expect(await peerHandleFor('pnyx_id_banned_nick')).toBeUndefined()
  })

  // Not knowing whether a handle backs a name is no reason to withhold the name.
  it('shows the nickname even when the handle contract could not be read', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(verdict({kind: 'unrenderable', reason: 'unverifiable'}, undefined))
    expect(await peerNicknameFor('pnyx_id_outage')).toBe('alice')
    expect(await peerHandleFor('pnyx_id_outage')).toBeUndefined()
  })

  // ⚠️ The bug this distinction exists to fix. `no-namespace` is a fact about the build, so the answer
  // is cacheable — where `unverifiable` is an outage and must never be. When they were one kind, a
  // build with no payment contract re-ran the entire join on every lookup, for ever.
  it('caches a no-namespace verdict, unlike an outage', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(verdict({kind: 'unrenderable', reason: 'no-namespace'}, undefined))
    expect(await peerNicknameFor('pnyx_id_nons')).toBe('alice')
    expect(knownPeerNickname('pnyx_id_nons')).toBe('alice')
    expect(knownPeerHandle('pnyx_id_nons')).toBeUndefined()
  })

  it('does not cache an outage verdict', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(verdict({kind: 'unrenderable', reason: 'unverifiable'}, undefined))
    expect(await peerNicknameFor('pnyx_id_outage2')).toBe('alice')
    expect(knownPeerNickname('pnyx_id_outage2')).toBeNull()
  })

  it('has no name of either kind for a row that names nothing', async () => {
    resolveIdentityRow.mockResolvedValue(row(NO_HANDLE))
    expect(await peerNicknameFor('pnyx_id_empty')).toBeUndefined()
    expect(await peerHandleFor('pnyx_id_empty')).toBeUndefined()
  })
})

describe('knownPeerNickname', () => {
  beforeEach(reset)
  afterEach(reset)

  // ⚠️ A nickname rests on the identity row alone, so a lapsed *handle* verdict must not retire it.
  // Expiring it there would re-read for a fact that cannot have changed, and flicker the name while
  // it did.
  it('survives a lapsed handle verdict, which retires the handle', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(agrees('alice'))
    expect(await peerHandleFor('pnyx_id_ttl')).toBe('alice')

    heights.set(HANDLE_ADDRESS, 2)
    expect(knownPeerHandle('pnyx_id_ttl')).toBeNull()
    expect(knownPeerNickname('pnyx_id_ttl')).toBe('alice')
  })

  it('is retired by the identity contract moving, which is what a rename moves', async () => {
    resolveIdentityRow.mockResolvedValue(row(encodeHandle('alice')))
    verifyRowName.mockResolvedValue(verdict({kind: 'unbound'}, undefined))
    expect(await peerNicknameFor('pnyx_id_rename')).toBe('alice')

    heights.set(identityAddressOf('pnyx_id_rename'), 2)
    expect(knownPeerNickname('pnyx_id_rename')).toBeNull()
  })
})
