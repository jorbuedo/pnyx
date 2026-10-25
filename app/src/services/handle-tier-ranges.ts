/**
 * The byte range each name tier covers, derived from {@link handleTier} rather than restated.
 *
 * The boundaries exist once, as a chain of comparisons inside `handleTier`, and the circuit probes the
 * same ones. A screen that listed them as its own table would be a second copy of a rule that must
 * agree with a frozen contract — and the first edit to either would show a user a length that costs
 * something else. So this walks every admissible length through the real function and groups the
 * result: the table cannot drift because it is not a table.
 *
 * @module
 */

import {handleTier, MAX_HANDLE_BYTES, MIN_HANDLE_BYTES} from '@pnyx/contract-client/handle'

export type TierRange = {
  readonly tier: number
  /** Inclusive, in **bytes** — which is characters only for ASCII. */
  readonly from: number
  readonly to: number
}

/**
 * Every tier, ascending, with the byte range it covers.
 *
 * ⚠️ Bytes, not characters. A name is limited by its UTF-8 length, so an emoji-free Latin name reads
 * one-to-one and a CJK one does not — which is why the copy says characters only where it is safe to.
 */
export const tierRanges = (): readonly TierRange[] => {
  const ranges: TierRange[] = []
  for (let size = MIN_HANDLE_BYTES; size <= MAX_HANDLE_BYTES; size++) {
    // `handleTier` reads a zero-padded, left-aligned name, so a run of non-zero bytes is a name of
    // that length. The bytes' values do not matter to the tier, only where the first zero is.
    const name = new Uint8Array(32)
    name.fill(0x61, 0, size)
    const tier = handleTier(name)
    const last = ranges[ranges.length - 1]
    if (last !== undefined && last.tier === tier) {
      ranges[ranges.length - 1] = {...last, to: size}
    } else {
      ranges.push({tier, from: size, to: size})
    }
  }
  return ranges
}
