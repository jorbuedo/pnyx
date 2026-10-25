/**
 * Which MLS group survives when a Welcome arrives for a conversation we already hold.
 *
 * Pure, and its own module, because it is the rule that decides whether two devices converge or
 * keep trading places — and because a rule that only exists inside the invite drain cannot be
 * tested without standing up MLS, a store and a service.
 *
 * | we hold | incoming | repair pending here | outcome |
 * |---|---|---|---|
 * | same group id | same | either | `duplicate` — a redelivery; nothing to do |
 * | a group | different | no | `adopt` — one-sided repair, and ours is the broken one |
 * | a group | different | yes, ours sorts first | `keep` — the peer will adopt ours by the same rule |
 * | a group | different | yes, theirs sorts first | `adopt` |
 *
 * ⚠️ **The `repair pending` column is what makes both cases work at once.** Without it, "always
 * adopt" fixes the one-sided break and turns a simultaneous one into an endless swap; "lower id
 * wins" fixes the simultaneous case and leaves a one-sided break unrepaired whenever the new group
 * happens to sort higher. The marker says *we* are the ones who rebuilt, which is exactly the
 * condition under which the tie-break is needed and the only condition under which it is safe.
 *
 * @module
 */

/** Lexicographic byte order — the same answer on both devices, from bytes both of them hold. */
export const compareGroupIds = (a: Uint8Array, b: Uint8Array): number => {
  const shared = Math.min(a.length, b.length)
  for (let index = 0; index < shared; index += 1) {
    const left = a[index] as number
    const right = b[index] as number
    if (left !== right) return left < right ? -1 : 1
  }
  return a.length - b.length
}

export type GroupChoice = 'duplicate' | 'adopt' | 'keep'

/**
 * @param ours the group id this device is currently in
 * @param theirs the group id of the Welcome that just arrived
 * @param repairPending whether this device rebuilt and is waiting for the peer to join
 */
export const chooseGroup = (ours: Uint8Array, theirs: Uint8Array, repairPending: boolean): GroupChoice => {
  const order = compareGroupIds(ours, theirs)
  if (order === 0) return 'duplicate'
  if (repairPending && order < 0) return 'keep'
  return 'adopt'
}
