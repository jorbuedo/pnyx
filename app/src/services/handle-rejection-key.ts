/**
 * One message per way a name is refused, so a field says what to change rather than which rule fired.
 *
 * **Shared, because two surfaces validate names and they must not disagree.** The handle claim form
 * and the onboarding nickname step run the same `validateHandle` — a nickname and a handle pass the
 * same rules, which is what makes "getting a handle" nothing more than registering the name you
 * already show. Two copies of this map would let one surface explain a refusal the other could not.
 *
 * Exhaustive over {@link HandleRejection} by type, so a rule added to `validateHandle` fails to
 * compile here instead of silently rendering nothing — which is how a user ends up with a disabled
 * button and no reason for it.
 *
 * @module
 */

import type {HandleRejection} from '@pnyx/contract-client/handle'

export const REJECTION_KEY = {
  empty: 'you.handle.invalidReason.tooShort',
  'too-short': 'you.handle.invalidReason.tooShort',
  'too-long': 'you.handle.invalidReason.tooLong',
  'disallowed-character': 'you.handle.invalidReason.disallowedCharacter',
  'leading-separator': 'you.handle.invalidReason.leadingSeparator',
  'trailing-separator': 'you.handle.invalidReason.trailingSeparator',
  'repeated-separator': 'you.handle.invalidReason.repeatedSeparator',
  'leading-combining-mark': 'you.handle.invalidReason.leadingCombiningMark',
  'too-many-combining-marks': 'you.handle.invalidReason.tooManyCombiningMarks',
  'not-canonical': 'you.handle.invalidReason.notCanonical',
  'invalid-utf8': 'you.handle.invalidReason.invalidUtf8',
  // `satisfies` rather than an annotation: exhaustiveness over `HandleRejection` is enforced, while
  // the values stay literal so `t()` still type-checks each key.
} as const satisfies Record<HandleRejection, string>
