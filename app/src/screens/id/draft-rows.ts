/**
 * Draft-row identity for the card editor.
 *
 * Its own module so it can be tested: the bug it fixes is invisible to a type-checker and only shows up
 * as a React warning at runtime.
 *
 * @module
 */

import type {CardEntry} from '@pnyx/contract-client/card'
import {type CardOption, optionForEntry, valueForEntry} from './card-kind-label'

/**
 * A draft row and its stable identity.
 *
 * ⚠️ The id exists only so React can key the list. Rows are reorderable by removal, and an index key
 * hands a row the previous occupant's input state — delete the second entry and the third one's text
 * appears in its place.
 */
export type DraftRow = {
  readonly id: number
  /**
   * What the row *is* — its kind and, for an address, the chain.
   *
   * ⚠️ Held apart from the value rather than derived from it: the chain lives inside a stored
   * `ChainAddress` value, so clearing the field would take the chain with it and the row would forget
   * which chain the user picked halfway through retyping an address.
   */
  readonly option: CardOption
  /** The value as typed — the bare address for a chain row, so the field never shows a CAIP-2 prefix. */
  readonly value: string
}

/** One row per entry, ids distinct. */
export const seedDraftRows = (entries: readonly CardEntry[]): DraftRow[] =>
  entries.map((entry, index) => ({id: index + 1, option: optionForEntry(entry), value: valueForEntry(entry)}))

/**
 * The next id, derived from the rows that exist rather than from a counter.
 *
 * ⚠️ It **was** a module-level counter, and that produced "two children with the same key" in
 * development: fast refresh re-evaluates the module and resets the counter to zero while React keeps the
 * component's state, so the next added row reused an id already in the draft. A module global is not a
 * valid identity source for state that outlives it. Reading the maximum of what is actually held cannot
 * collide, whatever the module did before — including after the highest row has been removed.
 */
export const nextRowId = (rows: readonly DraftRow[]): number => rows.reduce((max, row) => Math.max(max, row.id), 0) + 1
