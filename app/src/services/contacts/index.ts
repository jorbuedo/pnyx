/** Persisted contacts / address book (store + validation). @module */
export {
  type Contact,
  getContact,
  listContacts,
  newContactId,
  platformContactsStore,
  removeContact,
  saveContact,
} from './store'
export {type ContactValidation, isValidContactName, validateContactAddress} from './validation'
