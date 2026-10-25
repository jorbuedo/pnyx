/**
 * The shared wallet you are part-way through building, kept across the round trip
 * that assembling one requires.
 *
 * **Why this has to exist.** A shared wallet is not built in one sitting. You name
 * it, invite a co-signer over a DM, and wait — minutes or days — for their key to
 * come back. Accepting that key navigates to the create screen, and the create
 * screen held everything in React state, so it arrived empty: the name gone, and
 * every co-signer accepted before it gone with it. A 2-of-3 could never be
 * assembled, because each arriving key started a new wallet.
 *
 * So the editor's state is persisted and restored, and an arriving key is added to
 * the wallet being built rather than to a blank one.
 *
 * **One draft, not many.** Building two shared wallets at once is not a thing
 * anyone does, and a per-wallet draft would need a correlation id the key reply
 * does not carry — `buildCoSignerKeyMessage` sends a key, a name and an account
 * index, and nothing tying it to an invite. Inventing a match would be guessing
 * which wallet a key belongs to, and guessing wrong puts a stranger's key in
 * someone's spending policy. One draft is the honest shape for what the messages
 * actually say.
 *
 * **Public material only.** Rows hold account *public* keys — the same xpubs the
 * roster is made of and that co-signers hand out by design — plus a name and the
 * quorum being drafted. No secret is written here, which is why plain storage is
 * enough where the DM thread needs encryption.
 *
 * @module
 */

import type {StorageError} from '@pnyx/storage'
import {Effect} from 'effect'
import {logger} from '../../../logger'
import type {RosterDraft} from './roster-draft'

export const MULTISIG_DRAFT_KEY = '@pnyx/multisig_draft'

import {createProfileStorage} from '../../profile/profile-storage'

/** Bumped when the shape changes; an older or unknown version is discarded, not migrated. */
const DRAFT_VERSION = 1

export type MultisigDraft = {
  readonly walletName: string
  readonly rows: readonly RosterDraft[]
  readonly quorumKind: string
  readonly required: string
  readonly fromSlot: string
  readonly untilSlot: string
}

type StoredDraft = MultisigDraft & {readonly version: number}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

/** A stored row, or `null` when it is not one. Position carries no meaning here. */
const readRow = (raw: unknown): RosterDraft | null => {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || r.id === '') return null
  return {
    id: r.id,
    name: str(r.name),
    key: str(r.key),
    ...(r.isSelf === true ? {isSelf: true as const} : {}),
  }
}

/**
 * Read a stored draft, or `null` when there is nothing usable.
 *
 * Every field is read defensively rather than trusted: this is our own write, but
 * it survives app upgrades, and a half-read draft that seeded the editor with
 * `undefined` rows would be worse than starting empty. A row that will not read is
 * dropped; a draft whose rows all drop is discarded.
 */
export const decodeDraft = (raw: string | null): MultisigDraft | null => {
  if (raw === null || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e: unknown) {
    // `null` is also every shape check below. A draft that cannot be parsed is gone from the
    // list rather than shown as damaged.
    logger.warn('Multisig draft could not be parsed', {origin: 'multisig/draft-store', error: String(e)})
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const d = parsed as Record<string, unknown>
  if (d.version !== DRAFT_VERSION) return null
  const rows = (Array.isArray(d.rows) ? d.rows : []).map(readRow).filter((row): row is RosterDraft => row !== null)
  if (rows.length === 0) return null
  return {
    walletName: str(d.walletName),
    rows,
    quorumKind: str(d.quorumKind),
    required: str(d.required),
    fromSlot: str(d.fromSlot),
    untilSlot: str(d.untilSlot),
  }
}

export const encodeDraft = (draft: MultisigDraft): string =>
  JSON.stringify({version: DRAFT_VERSION, ...draft} satisfies StoredDraft)

/**
 * Whether a draft is worth keeping.
 *
 * An untouched editor — one blank row and no name — is not a draft, and writing it
 * would resurrect an empty form over a wallet the user had just finished. Only a
 * name or a row with something in it counts.
 */
export const isWorthKeeping = (draft: MultisigDraft): boolean =>
  draft.walletName.trim() !== '' || draft.rows.some((row) => row.name.trim() !== '' || row.key.trim() !== '')

const storage = () => createProfileStorage()

/** Read the saved draft. `null` when there is none, or none this build understands. */
export const loadDraft = (): Effect.Effect<MultisigDraft | null, StorageError> =>
  Effect.map(storage().get(MULTISIG_DRAFT_KEY), decodeDraft)

/** Save, or clear when there is nothing worth keeping. */
export const saveDraft = (draft: MultisigDraft): Effect.Effect<void, StorageError> =>
  isWorthKeeping(draft) ? storage().set(MULTISIG_DRAFT_KEY, encodeDraft(draft)) : forgetDraft()

/** Drop the draft — the wallet was created, or the user discarded it. */
export const forgetDraft = (): Effect.Effect<void, StorageError> => storage().remove(MULTISIG_DRAFT_KEY)
