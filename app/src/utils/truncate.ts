/**
 * Text truncation shared by every surface that renders a long chain id (hashes,
 * addresses, policy ids, pool/DRep ids).
 *
 * **Always keep a tail.** For a bech32 address or a hash the trailing characters
 * are what distinguish it — an attacker can grind a matching prefix, so a head
 * plus a tail is a far stronger check than a longer head alone. Never truncate
 * one of these with a bare `numberOfLines={1}`: RN/CSS ellipsis cuts at the tail
 * and throws away the identifying half.
 *
 * The budgets below are the only ones this app uses. Pick by how much room the
 * surface has, not by taste — scattered one-off constants are what this replaces.
 *
 * @module
 */

/** Middle-truncate a long id/hash: `abcd…wxyz`. Short inputs pass through. */
export const truncateMiddle = (value: string, head = 10, tail = 6): string =>
  value.length <= head + tail + 1 ? value : `${value.slice(0, head)}…${value.slice(-tail)}`

/**
 * A narrow value column beside a label (`DataRow`, `SettingsRow`) — roughly half
 * the row is already spent on the label.
 */
export const truncateCompact = (value: string): string => truncateMiddle(value, 12, 8)

/**
 * A full-width single-line row that carries nothing else: a UTxO outpoint, a
 * transaction id, a picker subtitle.
 */
export const truncateWide = (value: string): string => truncateMiddle(value, 20, 10)

/**
 * An address rendered as separate runs: a head that may be clipped to fit, then
 * `…`, the last {@link ADDRESS_TAIL} characters, then the highlighted last
 * {@link ADDRESS_HIGHLIGHT}.
 *
 * **Why the head is the only run allowed to shrink.** Everything after it is what
 * identifies the address, so only the head may be given up — and giving it up has
 * to be the *platform's* job, because a character budget cannot know how wide the
 * row it lands in is. It has been wrong twice: at the default head of 30 the runs
 * come to 45 characters, more than a review row or a receive row has once an icon,
 * a label and an amount have taken their share, and the platform then added its
 * **own** tail ellipsis on top of ours. Every address rendered with two, and the
 * second one ate the tail this module exists to keep. Each time it was fixed by
 * dialling `headChars` down at that one call site, which is why it came back at
 * the next surface.
 *
 * So the budget below is an upper bound rather than a measurement: the head run is
 * clipped (never ellipsized) by the platform when the row is narrower, `…` and the
 * tail are their own runs that cannot shrink, and no second ellipsis can appear
 * because the run that overflows has none to add. `ellipsizeMode="middle"` is not
 * an option: it truncates at the tail on RN-web, taking the highlight with it.
 */
export const ADDRESS_HIGHLIGHT = 6
export const ADDRESS_TAIL = 8
/** Fits the review/list rows this app renders addresses in, with room to spare. */
export const ADDRESS_HEAD = 30

export type AddressRuns = {
  /** The leading run — the only one a narrow row may clip. */
  readonly head: string
  /** Whether characters were dropped, so a `…` belongs between `head` and `tail`. */
  readonly elided: boolean
  /** The characters between the ellipsis and the highlight. Empty when nothing was dropped. */
  readonly tail: string
  /** The highlighted last characters. */
  readonly highlight: string
}

/**
 * Split an address into its runs. A value too short to truncate passes through as
 * `head` + `highlight` with no ellipsis, so nothing is ever duplicated or dropped.
 */
export const addressRuns = (address: string, headChars: number = ADDRESS_HEAD): AddressRuns => {
  const highlight = address.slice(-ADDRESS_HIGHLIGHT)
  const lead = address.slice(0, -ADDRESS_HIGHLIGHT)
  return lead.length <= headChars + ADDRESS_TAIL + 1
    ? {head: lead, elided: false, tail: '', highlight}
    : {head: lead.slice(0, headChars), elided: true, tail: lead.slice(-ADDRESS_TAIL), highlight}
}
