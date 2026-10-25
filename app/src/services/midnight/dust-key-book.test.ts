/**
 * The persisted DUST key book: its codec, and the rule that stops an append destroying it.
 *
 * @module
 */

import {Effect} from 'effect'
import {beforeEach, describe, expect, it, vi} from 'vitest'

const vault = {
  store: vi.fn(),
  retrieve: vi.fn(),
  has: vi.fn(),
}

vi.mock('../credential-vault', () => ({
  createEnclaveMnemonicVault: () => ({
    store: (...args: readonly unknown[]) => {
      const result = vault.store(...args)
      return result === null ? Effect.fail(new Error('keystore unavailable')) : Effect.void
    },
    retrieve: (...args: readonly unknown[]) => {
      const result = vault.retrieve(...args)
      return result === null ? Effect.fail(new Error('cancelled')) : Effect.succeed(result)
    },
    has: (...args: readonly unknown[]) => {
      const result = vault.has(...args)
      // `null` is the failure signal, as for the other two — a *typed* failure, which is what the
      // production code sees. A synchronous throw here would be a defect and `Effect.either` would not
      // catch it, so the test would prove something the runtime never does.
      return result === null ? Effect.fail(new Error('keystore unavailable')) : Effect.succeed(result)
    },
  }),
}))

const {
  appendDustKeysToBook,
  bookFromHeldKeys,
  DUST_KEY_BOOK_SLOT,
  forgetDustKeyForAccount,
  forgetDustKeysForGroup,
  parseDustKeyBook,
  restoreDustKeyBook,
  serializeDustKeyBook,
} = await import('./dust-key-book')
const {forgetAllSyncKeys, getSyncKeys, isSyncKeyBookRestored} = await import('./sync-keys-store')

const KEY_A = new Uint8Array(32).fill(0xaa)
const KEY_B = new Uint8Array(32).fill(0xbb)
const entryA = {
  groupId: 'group-aaaa',
  accountIndex: 0,
  dust: 'aa'.repeat(32),
  dustAddress: 'mn_dust_preprod1aaa',
  network: 'preprod',
}

beforeEach(() => {
  vi.clearAllMocks()
  forgetAllSyncKeys()
  vault.store.mockReturnValue(undefined)
  vault.has.mockReturnValue(false)
})

describe('the book codec', () => {
  it('round-trips an entry', () => {
    expect(parseDustKeyBook(serializeDustKeyBook([entryA]))).toEqual([entryA])
  })

  it('drops a malformed entry rather than defaulting it', () => {
    // ⚠️ A key that decoded to the wrong bytes derives a state the chain does not have, and the node
    // reports that as a bad *proof* — far harder to trace than an absent key, which just prompts.
    const raw = JSON.stringify([
      entryA,
      {...entryA, groupId: 'group-bbbb', dust: 'not-hex'},
      {...entryA, groupId: 'group-cccc', accountIndex: 1.5},
      {...entryA, groupId: 'group-dddd', dustAddress: ''},
      {...entryA, groupId: 'group-eeee', network: ''},
    ])
    expect(parseDustKeyBook(raw)).toEqual([entryA])
  })

  it('survives unreadable storage without throwing', () => {
    expect(parseDustKeyBook('not json at all')).toEqual([])
    expect(parseDustKeyBook('{"not":"an array"}')).toEqual([])
  })

  it('keeps a groupId that contains a colon intact', () => {
    // ⚠️ The identity is carried on the entry, not parsed back out of the cache key. While it *was*
    // parsed, a three-component key would have yielded a NaN account index for every wallet.
    void Effect.runSync(appendDustKeysToBook('group-a:b', 7, [{dust: KEY_A, dustAddress: 'mn', network: 'preprod'}]))
    expect(bookFromHeldKeys()).toEqual([
      {groupId: 'group-a:b', accountIndex: 7, dust: 'aa'.repeat(32), dustAddress: 'mn', network: 'preprod'},
    ])
  })
})

describe('restoring the book at unlock', () => {
  it('holds every entry and marks the book known', async () => {
    vault.has.mockReturnValue(true)
    vault.retrieve.mockReturnValue(serializeDustKeyBook([entryA, {...entryA, groupId: 'group-bbbb', accountIndex: 2}]))
    const held = await Effect.runPromise(restoreDustKeyBook('read the dust keys'))
    expect(held).toBe(2)
    expect(getSyncKeys('group-aaaa', 0, 'preprod')?.dust).toEqual(KEY_A)
    expect(isSyncKeyBookRestored()).toBe(true)
  })

  it('holds every network an account has, not just the last one read', async () => {
    // ⚠️ **The persistence half of the network-keying regression.** The stored format always carried
    // `network` per entry, so a book could hold one account twice — but the cache it was replayed
    // into was keyed `groupId:accountIndex`, so the second `putSyncKeys` evicted the first and the
    // wallet came back holding exactly one network. Reading it back is what the scheduler does on
    // every tick, so this is the shape that stranded a wallet across a network switch.
    vault.has.mockReturnValue(true)
    vault.retrieve.mockReturnValue(
      serializeDustKeyBook([entryA, {...entryA, network: 'preview', dustAddress: 'mn_dust_preview1aaa'}]),
    )

    expect(await Effect.runPromise(restoreDustKeyBook())).toBe(2)
    // ⚠️ Assert the **address**, per network, and in that order. Asserting the key would pass under
    // the collapsed cache too: both entries carry the same role key, so a lookup that ignores the
    // network still returns matching bytes. The address is the only field that differs.
    expect(getSyncKeys('group-aaaa', 0, 'preprod')?.dustAddress).toBe('mn_dust_preprod1aaa')
    expect(getSyncKeys('group-aaaa', 0, 'preview')?.dustAddress).toBe('mn_dust_preview1aaa')
  })

  it('treats an absent slot as known, so the first wallet can write one', async () => {
    vault.has.mockReturnValue(false)
    await Effect.runPromise(restoreDustKeyBook())
    // "Read it and there is nothing" is a known state; only "never read" must block a write.
    expect(isSyncKeyBookRestored()).toBe(true)
    expect(vault.retrieve).not.toHaveBeenCalled()
  })

  it('does not mark the book known when the existence probe fails', async () => {
    // ⚠️ A failed probe is not "there is no book". Collapsing them would mark the book known-absent and
    // let the next append replace a real one with a single entry — the clobber, by the back door.
    vault.has.mockReturnValue(null)
    const held = await Effect.runPromise(restoreDustKeyBook())
    expect(held).toBe(0)
    expect(isSyncKeyBookRestored()).toBe(false)
  })

  it('does not re-read the slot once the book is held, so a remount costs no prompt', async () => {
    // The provider tree is keyed on the funds network, so switching mainnet→preview remounts the hook
    // that restores this. The keys survive that (module cache, cleared only on lock), so a second read
    // would fire an OS prompt to learn what is already in hand.
    vault.has.mockReturnValue(true)
    vault.retrieve.mockReturnValue(serializeDustKeyBook([entryA]))
    expect(await Effect.runPromise(restoreDustKeyBook())).toBe(1)

    vault.has.mockClear()
    vault.retrieve.mockClear()

    expect(await Effect.runPromise(restoreDustKeyBook())).toBe(1)
    expect(vault.retrieve).not.toHaveBeenCalled()
    expect(vault.has).not.toHaveBeenCalled()
    expect(getSyncKeys('group-aaaa', 0, 'preprod')?.dust).toEqual(KEY_A)
  })

  it('reads the slot again after a lock, because lock is what ends the hold', async () => {
    vault.has.mockReturnValue(true)
    vault.retrieve.mockReturnValue(serializeDustKeyBook([entryA]))
    await Effect.runPromise(restoreDustKeyBook())

    forgetAllSyncKeys()
    vault.retrieve.mockClear()

    expect(await Effect.runPromise(restoreDustKeyBook())).toBe(1)
    expect(vault.retrieve).toHaveBeenCalledOnce()
  })

  it('does not mark the book known when the read fails', async () => {
    // A cancelled prompt or an unreachable keystore. DUST stays as stale as it is today, and unlock is
    // never blocked by a sync convenience — but an append must not now assume it knows the book.
    vault.has.mockReturnValue(true)
    vault.retrieve.mockReturnValue(null)
    const held = await Effect.runPromise(restoreDustKeyBook())
    expect(held).toBe(0)
    expect(isSyncKeyBookRestored()).toBe(false)
  })
})

describe('appending a key', () => {
  it('writes the whole book without reading it back', async () => {
    vault.has.mockReturnValue(false)
    await Effect.runPromise(restoreDustKeyBook())
    vault.retrieve.mockClear()

    await Effect.runPromise(
      appendDustKeysToBook('group-aaaa', 0, [{dust: KEY_A, dustAddress: 'mn_dust_preprod1aaa', network: 'preprod'}]),
    )
    await Effect.runPromise(
      appendDustKeysToBook('group-bbbb', 0, [{dust: KEY_B, dustAddress: 'mn_dust_preprod1bbb', network: 'preprod'}]),
    )

    // ⚠️ No retrieve anywhere: appending is not read-modify-write, because while unlocked the cache
    // already *is* the book. That is what keeps wallet creation prompt-free.
    expect(vault.retrieve).not.toHaveBeenCalled()
    const [slot, written] = vault.store.mock.calls.at(-1) ?? []
    expect(slot).toBe(DUST_KEY_BOOK_SLOT)
    expect(parseDustKeyBook(String(written)).map((one) => one.groupId)).toEqual(['group-aaaa', 'group-bbbb'])
  })

  it('stores no auth prompt, because writing is not gated', async () => {
    vault.has.mockReturnValue(false)
    await Effect.runPromise(restoreDustKeyBook())
    await Effect.runPromise(
      appendDustKeysToBook('group-aaaa', 0, [{dust: KEY_A, dustAddress: 'mn', network: 'preprod'}]),
    )
    // A third argument would be an `authenticationPrompt`, i.e. a biometric on wallet creation.
    expect(vault.store.mock.calls.at(-1)?.[2]).toBeUndefined()
  })

  it('refuses to persist when the book was never read, rather than replacing it with one entry', async () => {
    // ⚠️ The dangerous case, and the only one. The read failed at unlock, so the cache is empty for a
    // reason that is *not* "the book is empty" — writing it back would drop every other wallet's key.
    vault.has.mockReturnValue(true)
    vault.retrieve.mockReturnValue(null)
    await Effect.runPromise(restoreDustKeyBook())
    expect(isSyncKeyBookRestored()).toBe(false)

    await Effect.runPromise(
      appendDustKeysToBook('group-aaaa', 0, [{dust: KEY_A, dustAddress: 'mn', network: 'preprod'}]),
    )

    expect(vault.store).not.toHaveBeenCalled()
    // The key is still held, so *this* session syncs — only the persistence is skipped.
    expect(getSyncKeys('group-aaaa', 0, 'preprod')?.dust).toEqual(KEY_A)
  })

  it('holds the key even when the write fails', async () => {
    vault.has.mockReturnValue(false)
    await Effect.runPromise(restoreDustKeyBook())
    vault.store.mockReturnValue(null)
    await Effect.runPromise(
      appendDustKeysToBook('group-aaaa', 0, [{dust: KEY_A, dustAddress: 'mn', network: 'preprod'}]),
    )
    // A failed write must not also cost the session its keys; it is logged at error level.
    expect(getSyncKeys('group-aaaa', 0, 'preprod')?.dust).toEqual(KEY_A)
  })
})

describe('forgetting keys', () => {
  const seedTwoWallets = async () => {
    vault.has.mockReturnValue(false)
    await Effect.runPromise(restoreDustKeyBook())
    await Effect.runPromise(
      appendDustKeysToBook('group-aaaa', 0, [{dust: KEY_A, dustAddress: 'mn-a', network: 'preprod'}]),
    )
    await Effect.runPromise(
      appendDustKeysToBook('group-aaaa', 1, [{dust: KEY_A, dustAddress: 'mn-a1', network: 'preprod'}]),
    )
    await Effect.runPromise(
      appendDustKeysToBook('group-bbbb', 0, [{dust: KEY_B, dustAddress: 'mn-b', network: 'preprod'}]),
    )
    vault.store.mockClear()
  }

  it('drops every account of a deleted wallet and keeps the others', async () => {
    await seedTwoWallets()
    await Effect.runPromise(forgetDustKeysForGroup('group-aaaa'))
    // A wallet's accounts all derive from its one seed, so deleting the wallet retires all of them.
    expect(getSyncKeys('group-aaaa', 0, 'preprod')).toBeUndefined()
    expect(getSyncKeys('group-aaaa', 1, 'preprod')).toBeUndefined()
    expect(getSyncKeys('group-bbbb', 0, 'preprod')?.dust).toEqual(KEY_B)
    const written = parseDustKeyBook(String(vault.store.mock.calls.at(-1)?.[1]))
    expect(written.map((one) => one.groupId)).toEqual(['group-bbbb'])
  })

  it('matches a group by its full prefix, not a partial one', async () => {
    // ⚠️ `group-aaaa` must not take `group-aaaabbbb` with it. The separator is what makes the prefix
    // unambiguous, and dropping it would delete a bystander's keys.
    vault.has.mockReturnValue(false)
    await Effect.runPromise(restoreDustKeyBook())
    await Effect.runPromise(
      appendDustKeysToBook('group-aaaa', 0, [{dust: KEY_A, dustAddress: 'mn', network: 'preprod'}]),
    )
    await Effect.runPromise(
      appendDustKeysToBook('group-aaaabbbb', 0, [{dust: KEY_B, dustAddress: 'mn', network: 'preprod'}]),
    )
    await Effect.runPromise(forgetDustKeysForGroup('group-aaaa'))
    expect(getSyncKeys('group-aaaabbbb', 0, 'preprod')?.dust).toEqual(KEY_B)
  })

  it('writes nothing when the group held no keys', async () => {
    await seedTwoWallets()
    await Effect.runPromise(forgetDustKeysForGroup('group-cccc'))
    // Nothing changed, so nothing is rewritten — a keychain write per no-op deletion is pure noise.
    expect(vault.store).not.toHaveBeenCalled()
  })

  it('drops one disabled account and leaves its siblings', async () => {
    await seedTwoWallets()
    await Effect.runPromise(forgetDustKeyForAccount('group-aaaa', 1))
    expect(getSyncKeys('group-aaaa', 0, 'preprod')?.dust).toEqual(KEY_A)
    expect(getSyncKeys('group-aaaa', 1, 'preprod')).toBeUndefined()
  })

  it('refuses to persist a deletion when the book was never read', async () => {
    // ⚠️ Worse here than on an append: writing an unrestored cache after a deletion would look like it
    // worked while erasing every surviving wallet's key.
    vault.has.mockReturnValue(true)
    vault.retrieve.mockReturnValue(null)
    await Effect.runPromise(restoreDustKeyBook())
    await Effect.runPromise(
      appendDustKeysToBook('group-aaaa', 0, [{dust: KEY_A, dustAddress: 'mn', network: 'preprod'}]),
    )
    vault.store.mockClear()
    await Effect.runPromise(forgetDustKeysForGroup('group-aaaa'))
    expect(vault.store).not.toHaveBeenCalled()
  })
})
