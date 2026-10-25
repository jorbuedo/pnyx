/**
 * Persisted contacts / address book: user-labelled saved addresses, keyed
 * `contacts.{id}` over the platform storage layer. Mirrors the pending-cosign
 * registry — a prefix-scanned key/value store. Non-secret data only (labels +
 * public addresses).
 *
 * @module
 */

import type {ChainId} from '@pnyx/config'
import type {Storage, StorageError} from '@pnyx/storage'
import {Effect} from 'effect'
import {logger} from '../../logger'
import {createProfileStorage} from '../profile/profile-storage'

const PREFIX = 'contacts.'
const keyOf = (id: string): string => `${PREFIX}${id}`

export type Contact = {
  readonly id: string
  readonly name: string
  readonly addressBech32: string
  readonly chain: ChainId
  readonly note?: string
  readonly createdAt: number
}

let contactCounter = 0
/** Stable id for a new contact (timestamp + monotonic counter). */
export const newContactId = (): string => {
  contactCounter += 1
  return `${Date.now().toString(36)}-${contactCounter.toString(36)}`
}

const parse = (raw: string): Contact | null => {
  try {
    return JSON.parse(raw) as Contact
  } catch (e: unknown) {
    // `null` drops the contact, so a damaged record is missing from the list rather than shown
    // as one that needs fixing.
    logger.warn('Contact record could not be parsed; it will not be listed', {
      origin: 'contacts/store',
      error: String(e),
    })
    return null
  }
}

export const saveContact = (storage: Storage, contact: Contact): Effect.Effect<void, StorageError> =>
  storage.set(keyOf(contact.id), JSON.stringify(contact))

export const getContact = (storage: Storage, id: string): Effect.Effect<Contact | null, StorageError> =>
  Effect.map(storage.get(keyOf(id)), (raw) => (raw === null ? null : parse(raw)))

export const removeContact = (storage: Storage, id: string): Effect.Effect<void, StorageError> =>
  storage.remove(keyOf(id))

export const listContacts = (storage: Storage): Effect.Effect<readonly Contact[], StorageError> =>
  Effect.gen(function* () {
    const keys = (yield* storage.keys()).filter((k) => k.startsWith(PREFIX))
    const out: Contact[] = []
    for (const key of keys) {
      const raw = yield* storage.get(key)
      const contact = raw === null ? null : parse(raw)
      if (contact) out.push(contact)
    }
    return out.sort((a, b) => a.createdAt - b.createdAt)
  })

/** Bind the contacts ops to the platform storage instance (app runtime). */
export const platformContactsStore = (): {
  readonly save: (contact: Contact) => Effect.Effect<void, StorageError>
  readonly get: (id: string) => Effect.Effect<Contact | null, StorageError>
  readonly remove: (id: string) => Effect.Effect<void, StorageError>
  readonly list: () => Effect.Effect<readonly Contact[], StorageError>
} => {
  const storage = createProfileStorage()
  return {
    save: (contact) => saveContact(storage, contact),
    get: (id) => getContact(storage, id),
    remove: (id) => removeContact(storage, id),
    list: () => listContacts(storage),
  }
}
