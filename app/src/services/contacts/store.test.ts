import {CARDANO_MAINNET} from '@pnyx/config'
import {createMemoryStorage} from '@pnyx/storage'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {type Contact, getContact, listContacts, newContactId, removeContact, saveContact} from './store'

const contact = (over: Partial<Contact> = {}): Contact => ({
  id: 'k1',
  name: 'Alice',
  addressBech32: 'addr_test1qxyz',
  chain: CARDANO_MAINNET,
  createdAt: 1,
  ...over,
})

describe('contacts store', () => {
  it('round-trips a contact through save → get', async () => {
    const storage = createMemoryStorage()
    const c = contact({note: 'friend'})
    await Effect.runPromise(saveContact(storage, c))
    expect(await Effect.runPromise(getContact(storage, 'k1'))).toEqual(c)
  })

  it('returns null for an absent contact', async () => {
    const storage = createMemoryStorage()
    expect(await Effect.runPromise(getContact(storage, 'nope'))).toBeNull()
  })

  it('lists contacts ordered by createdAt', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(saveContact(storage, contact({id: 'b', createdAt: 20})))
    await Effect.runPromise(saveContact(storage, contact({id: 'a', createdAt: 10})))
    const list = await Effect.runPromise(listContacts(storage))
    expect(list.map((c) => c.id)).toEqual(['a', 'b'])
  })

  it('removes a contact', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(saveContact(storage, contact()))
    await Effect.runPromise(removeContact(storage, 'k1'))
    expect(await Effect.runPromise(getContact(storage, 'k1'))).toBeNull()
  })

  it('scopes its keys under the contacts prefix and ignores foreign keys', async () => {
    const storage = createMemoryStorage()
    await Effect.runPromise(storage.set('dapp.sessions', '[]'))
    await Effect.runPromise(saveContact(storage, contact()))
    expect(await Effect.runPromise(listContacts(storage))).toHaveLength(1)
    const keys = await Effect.runPromise(storage.keys())
    expect(keys).toContain('contacts.k1')
  })

  it('mints unique ids', () => {
    expect(newContactId()).not.toBe(newContactId())
  })
})
