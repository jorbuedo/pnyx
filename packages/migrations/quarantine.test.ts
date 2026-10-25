import {createMemoryStorage} from '@pnyx/storage/memory'
import {Storage} from '@pnyx/storage/types'
import {Effect, Layer} from 'effect'
import {describe, expect, it} from 'vitest'
import {buildQuarantineKey, QUARANTINE_KEEP, quarantine} from './quarantine.js'

describe('buildQuarantineKey', () => {
  it('produces a key that includes the ISO timestamp', () => {
    const now = new Date('2026-04-20T10:00:00.000Z')
    expect(buildQuarantineKey('user', now)).toBe('user:quarantined:2026-04-20T10:00:00.000Z')
  })

  it('namespaces under the original key so lookup is easy', () => {
    const now = new Date('2026-04-20T10:00:00.000Z')
    expect(buildQuarantineKey('@pnyx/wallet/groups', now)).toBe(
      '@pnyx/wallet/groups:quarantined:2026-04-20T10:00:00.000Z',
    )
  })
})

describe('quarantine', () => {
  it('moves the raw value to a sibling key and deletes the original', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(storage.set('user', 'corrupt-bytes'))

    const now = new Date('2026-04-20T10:00:00.000Z')
    await Effect.runPromise(
      quarantine('user', 'corrupt-bytes', now).pipe(Effect.provide(Layer.succeed(Storage, storage))),
    )

    const original = await Effect.runPromise(storage.get('user'))
    expect(original).toBeNull()

    const qKey = buildQuarantineKey('user', now)
    const quarantined = await Effect.runPromise(storage.get(qKey))
    expect(quarantined).toBe('corrupt-bytes')
  })

  it('prunes older siblings so only QUARANTINE_KEEP copies remain', async () => {
    const storage = createMemoryStorage()
    // Seed a larger number of quarantine siblings spread across fake
    // timestamps — they should compact down to the tail of the most
    // recent QUARANTINE_KEEP on the next quarantine.
    const seedCount = QUARANTINE_KEEP + 4
    for (let i = 0; i < seedCount; i++) {
      const ts = new Date(`2026-04-20T10:00:0${i}.000Z`).toISOString()
      await Effect.runPromise(storage.set(`user:quarantined:${ts}`, `old-${i}`))
    }

    // Unrelated sibling that must NOT be touched — same storage, different key.
    await Effect.runPromise(storage.set('other-key:quarantined:2026-04-20T09:00:00.000Z', 'keep'))

    // Trigger a fresh quarantine at a later timestamp.
    await Effect.runPromise(storage.set('user', 'corrupt-bytes'))
    const now = new Date('2026-04-20T10:30:00.000Z')
    await Effect.runPromise(
      quarantine('user', 'corrupt-bytes', now).pipe(Effect.provide(Layer.succeed(Storage, storage))),
    )

    const allKeys = await Effect.runPromise(storage.keys())
    const userSiblings = allKeys.filter((k) => k.startsWith('user:quarantined:')).sort()
    // After quarantine we have QUARANTINE_KEEP copies total: the newest
    // seeds plus the one we just wrote.
    expect(userSiblings).toHaveLength(QUARANTINE_KEEP)

    // The newly-written quarantine must be present…
    expect(userSiblings).toContain(buildQuarantineKey('user', now))

    // …and the other-key sibling must be untouched.
    expect(allKeys).toContain('other-key:quarantined:2026-04-20T09:00:00.000Z')
  })
})
