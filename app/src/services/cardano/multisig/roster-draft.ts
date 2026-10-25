/**
 * The create-multisig roster as pure state: rows in, a validated roster out.
 *
 * Lives outside the screen so the editor's rules are testable — the previous
 * version kept them inline and shipped two defects a test would have caught: a
 * row could never be removed, and "Add yourself" prepended the self row while
 * leaving the initial blank one behind, so the form stayed invalid with nothing
 * on screen explaining why.
 *
 * @module
 */

import {XpubHex} from '@evolution-sdk/review/Brands'
import {Either} from 'effect'
import {decodeAccountXvk} from './shared-key'
import {tagAt} from './template'
import type {CoSignerRef} from './types'

export type RosterDraft = {
  readonly id: string
  readonly name: string
  /** `acct_shared_xvk1…`, or a bare 64-byte hex xpub. */
  readonly key: string
  readonly isSelf?: boolean
}

/** A 64-byte account xpub as hex: 32-byte public key ‖ 32-byte chain code. */
const HEX_XPUB = /^[0-9a-fA-F]{128}$/

export type DraftProblem = 'empty' | 'bad-key' | 'no-name'

let draftSeq = 0
export const newDraft = (fields: Omit<RosterDraft, 'id'>): RosterDraft => {
  draftSeq += 1
  return {id: `d${draftSeq}`, ...fields}
}

/**
 * Take rows that came back from storage into this session, on this session's ids.
 *
 * The counter above restarts at zero every app start, and `draft-store` persists
 * the ids it minted, so a restored `d3` and the next row the user adds are the
 * same id in two different rows — React renders one of them and drops the other.
 * An id identifies a row only while the editor is open, so re-minting costs
 * nothing and leaves every live id from one counter.
 */
export const adoptRestoredDrafts = (rows: readonly RosterDraft[]): readonly RosterDraft[] =>
  rows.map((row) => newDraft({name: row.name, key: row.key, ...(row.isSelf === true ? {isSelf: true} : {})}))

/** A fresh editor: one blank row to type into. */
export const initialDrafts = (): readonly RosterDraft[] => [newDraft({name: '', key: ''})]

export const isBlank = (draft: RosterDraft): boolean => draft.name.trim() === '' && draft.key.trim() === ''

/**
 * Read a row's key.
 *
 * Bech32 is the interchange form and is checked against its CIP-5 prefix, so an
 * ordinary `acct_xvk` (a CIP-1852 spending key) cannot land in a shared roster.
 * Bare hex is accepted because that is what a developer or another tool may
 * paste, and it carries no prefix to confuse.
 */
export const parseDraftKey = (key: string): Either.Either<string, DraftProblem> => {
  const trimmed = key.trim()
  if (trimmed === '') return Either.left('empty')
  if (HEX_XPUB.test(trimmed)) return Either.right(trimmed.toLowerCase())
  const decoded = decodeAccountXvk(trimmed)
  return Either.isRight(decoded) ? Either.right(decoded.right) : Either.left('bad-key')
}

export type DraftRow = {
  readonly draft: RosterDraft
  readonly problem: DraftProblem | null
  readonly accountXpubHex: string | null
}

/** Validate every row, keeping order. Blank rows report `empty`, not `bad-key`. */
export const inspectDrafts = (drafts: readonly RosterDraft[]): readonly DraftRow[] =>
  drafts.map((draft) => {
    const parsed = parseDraftKey(draft.key)
    if (Either.isLeft(parsed)) return {draft, problem: parsed.left, accountXpubHex: null}
    if (draft.name.trim() === '') return {draft, problem: 'no-name', accountXpubHex: parsed.right}
    return {draft, problem: null, accountXpubHex: parsed.right}
  })

/**
 * The roster, or `null` when a row that *says* something is unusable.
 *
 * ⚠️ **A blank row is an empty slot, not a co-signer.** It is skipped rather than
 * refused: the editor keeps one around to type into, and the last one cannot be
 * removed, so treating it as a broken participant made an untouched form report
 * an incomplete co-signer — and after the "remove" action became contextual,
 * a stray blank row would have blocked Create with nothing the user could do
 * about it. A row with *something* in it is still validated in full.
 *
 * Tags are assigned by final position, so the roster order *is* the tag order —
 * which is why the editor must not silently reorder rows.
 */
export const draftsToRoster = (
  drafts: readonly RosterDraft[],
  /**
   * Whether a key is one of this device's, by xpub.
   *
   * ⚠️ **Ownership is a property of the key, not of how the row was filled.** The
   * editor used to carry an `isSelf` flag set only by the own-wallet picker, so a
   * key you pasted or scanned was recorded as someone else's — and picking a
   * *second* of your own wallets left that one unmarked too, because the flag was
   * tied to a single `selfGroupId`. Every row whose key you hold is yours, and
   * more than one can be.
   */
  isMine?: (accountXpubHex: string) => boolean,
): readonly CoSignerRef[] | null => {
  const rows = inspectDrafts(drafts.filter((draft) => !isBlank(draft)))
  if (rows.length === 0 || rows.some((r) => r.problem !== null)) return null
  return rows.map((r, i) => {
    // Checked by inspectDrafts: problem === null implies a parsed key.
    const accountXpubHex = XpubHex(r.accountXpubHex ?? '')
    const mine = isMine === undefined ? r.draft.isSelf === true : isMine(accountXpubHex)
    return {
      tag: tagAt(i),
      name: r.draft.name.trim(),
      accountXpubHex,
      ...(mine ? {isSelf: true} : {}),
    }
  })
}

export const addBlankDraft = (drafts: readonly RosterDraft[]): readonly RosterDraft[] => [
  ...drafts,
  newDraft({name: '', key: ''}),
]

/**
 * Remove a row, keeping at least one so the editor never renders empty.
 *
 * Removing the last row replaces it with a blank rather than leaving nothing —
 * an empty editor offers no way back to a usable state.
 */
export const removeDraft = (drafts: readonly RosterDraft[], id: string): readonly RosterDraft[] => {
  const next = drafts.filter((d) => d.id !== id)
  return next.length === 0 ? initialDrafts() : next
}

export const updateDraft = (
  drafts: readonly RosterDraft[],
  id: string,
  patch: Partial<Omit<RosterDraft, 'id'>>,
): readonly RosterDraft[] => drafts.map((d) => (d.id === id ? {...d, ...patch} : d))

/**
 * Empty a row without removing it.
 *
 * The first row cannot be removed — a wallet with no co-signers is not a wallet,
 * and a form that can reach that state offers a Create button that can never
 * work. Clearing is what "remove" means for it.
 *
 * `isSelf` goes too: a cleared row is no longer this wallet's own key, and a row
 * still claiming to be would keep its fields locked with nothing in them.
 */
export const clearDraft = (drafts: readonly RosterDraft[], id: string): readonly RosterDraft[] =>
  drafts.map((d) => (d.id === id ? {id: d.id, name: '', key: ''} : d))

/**
 * Fill one row from a wallet on this device.
 *
 * In place, unlike {@link upsertSelfDraft}: the row is the one whose header the
 * user pressed, and moving it to the top would answer a question they did not ask.
 *
 * It marks nothing as "mine" — whether a row is ours follows from its key
 * matching one of our wallets (`localWalletForKey`), so a row filled here and the
 * identical key typed by hand read the same, and two of your own wallets in one
 * roster are both recognised.
 */
export const fillFromOwnWallet = (
  drafts: readonly RosterDraft[],
  id: string,
  wallet: {readonly name: string; readonly accountXpubHex: string},
): readonly RosterDraft[] =>
  drafts.map((d) => (d.id === id ? {id: d.id, name: wallet.name, key: wallet.accountXpubHex} : d))

/**
 * Put this wallet's own key at the top of the roster.
 *
 * Replaces any previous self row, and drops blank rows — leaving the untouched
 * starter row behind is what used to keep the form invalid after the only
 * action the user had taken.
 */
export const upsertSelfDraft = (
  drafts: readonly RosterDraft[],
  self: {readonly name: string; readonly accountXpubHex: string},
): readonly RosterDraft[] => {
  const others = drafts.filter((d) => d.isSelf !== true && !isBlank(d))
  return [newDraft({name: self.name, key: self.accountXpubHex, isSelf: true}), ...others]
}

/**
 * Add a co-signer whose key is already known — from the wallet picker, a scan,
 * or an invite reply.
 *
 * Fills the first blank row rather than appending past it, so an untouched
 * starter row does not sit between the rows the user actually added and keep the
 * form invalid.
 */
export const appendCoSigner = (
  drafts: readonly RosterDraft[],
  coSigner: {readonly name: string; readonly accountXpubHex: string},
): readonly RosterDraft[] => {
  const row = newDraft({name: coSigner.name, key: coSigner.accountXpubHex})
  const blankIndex = drafts.findIndex(isBlank)
  if (blankIndex === -1) return [...drafts, row]
  return [...drafts.slice(0, blankIndex), row, ...drafts.slice(blankIndex + 1)]
}

/** Whether the roster already holds this key, ignoring one row by id. */
export const hasDuplicateKey = (drafts: readonly RosterDraft[], accountXpubHex: string, exceptId?: string): boolean =>
  inspectDrafts(drafts).some(
    (r) => r.draft.id !== exceptId && r.accountXpubHex?.toLowerCase() === accountXpubHex.toLowerCase(),
  )
