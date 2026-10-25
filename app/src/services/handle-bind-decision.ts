/**
 * What a claim does next, given whose the shell's name already is.
 *
 * Its own module because it is a pure decision and the module it came from cannot be imported without
 * the native proving bridge. Four inputs, four outcomes, and the one that matters is `mine`:
 *
 * | the shell says | what happens | why |
 * |---|---|---|
 * | nobody owns it | `bind` | the ordinary claim |
 * | this identity owns it | **skip to `setPrimaryName`** | the name is already held; only the row is missing |
 * | another identity owns it | refuse, `taken` | `bind` asserts an unowned shell |
 * | banned or burned | refuse, `reserved` | never usable, so a retry can never succeed |
 *
 * ⚠️ Before this existed every owned shell failed the same way, `bind`'s assert being the only judge —
 * so a claim whose `bind` landed and whose `setPrimaryName` did not told its **owner** the name was
 * taken and could not be finished from the UI. Two names on preprod were left in exactly that state.
 *
 * @module
 */

import type {HandleOwnership} from '@pnyx/contract-client/handle-validity'

/** The step a claim takes next. */
export type BindStep =
  /** Prove and relay `bind`. */
  | {readonly kind: 'bind'}
  /** The name is already this identity's — go straight to the write that displays it. */
  | {readonly kind: 'already-bound'}
  /** Stop, with the reason to tell the user. */
  | {readonly kind: 'refuse'; readonly reason: 'taken' | 'reserved'}

export const bindStep = (held: HandleOwnership): BindStep => {
  switch (held) {
    case 'unbound':
      return {kind: 'bind'}
    case 'mine':
      return {kind: 'already-bound'}
    case 'someone-else':
      return {kind: 'refuse', reason: 'taken'}
    case 'banned':
    case 'burned':
      return {kind: 'refuse', reason: 'reserved'}
    default: {
      const unhandled: never = held
      return unhandled
    }
  }
}
