/**
 * The hand-off from a metadata block to the screen that renders it in full.
 *
 * A metadata payload is not a route parameter: the labels seen on chain pretty-print
 * to hundreds of lines, and a transaction still under review has no hash to fetch it
 * back by — so the block that already holds the entry parks it here, and the screen
 * reads it by the same label.
 *
 * Keyed, and cleared on every write: an unkeyed single slot serves the previous
 * transaction's payload whenever the write and the read disagree.
 *
 * @module
 */

export type PendingMetadata = {
  /** Already translated by the block that owns the entry. */
  readonly heading: string
  readonly lines: readonly string[]
}

const pending = new Map<string, PendingMetadata>()

export const setPendingMetadata = (label: string, value: PendingMetadata): void => {
  pending.clear()
  pending.set(label, value)
}

/** The parked payload for this label, or `undefined` when nothing parked it. */
export const readPendingMetadata = (label: string): PendingMetadata | undefined => pending.get(label)
