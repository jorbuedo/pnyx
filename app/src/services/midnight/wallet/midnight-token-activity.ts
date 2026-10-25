/**
 * What a Midnight token's detail screen shows under Activity.
 *
 * A decision rule rather than a filter call, because "nothing to show" has three different meanings here
 * and only one of them is "this token never moved":
 *
 * | rail | items | verdict |
 * |---|---|---|
 * | shielded | (ignored) | `unavailable` — a shielded coin has no address, so no history exists to read |
 * | unshielded | `null` | `unknown` — nothing has been read for this address yet |
 * | unshielded | none touching this token | `empty` — read, and this token did not move |
 * | unshielded | some | `list` |
 *
 * The shielded row is the one that matters: rendering "No activity" there would state that a holding never
 * moved, when the truth is that we cannot see whether it did. See `midnight-activity` for why.
 *
 * @module
 */

import type {MidnightActivity} from './midnight-activity'
import type {MidnightRail} from './midnight-asset-id'

export type MidnightTokenActivity =
  | {readonly kind: 'unavailable'}
  | {readonly kind: 'unknown'}
  | {readonly kind: 'empty'}
  | {readonly kind: 'list'; readonly items: readonly MidnightActivity[]}

export const midnightTokenActivity = (input: {
  readonly rail: MidnightRail
  readonly tokenType: string
  readonly items: readonly MidnightActivity[] | null
}): MidnightTokenActivity => {
  if (input.rail === 'shielded') return {kind: 'unavailable'}
  if (input.items === null) return {kind: 'unknown'}
  // Participation, not balance change: a self-send nets to zero for this token and its `netByToken`
  // entry is therefore absent, which used to filter it out of the very list it belongs in.
  const items = input.items.filter((activity) => activity.tokens.has(input.tokenType))
  return items.length === 0 ? {kind: 'empty'} : {kind: 'list', items}
}
