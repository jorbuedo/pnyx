/**
 * How a shared wallet's time bound is entered: as a date, or as the raw slot
 * number underneath it.
 *
 * The slot is what the script contains, so it stays the value the screen holds.
 * A date is an interpretation of it, available only while the network's slot↔time
 * anchor is resolved — and only for a slot that anchor can actually place. When
 * either is missing the screen shows the number, because a date field that cannot
 * show the bound already entered would misrepresent what is in the wallet.
 *
 * | anchor resolved | bound entered      | shown as |
 * |-----------------|--------------------|----------|
 * | no              | anything           | `slot`   |
 * | yes             | none               | `picker` |
 * | yes             | places to a date   | `picker` |
 * | yes             | does not place     | `slot`   |
 *
 * @module
 */

/** A slot bound the user typed. Empty means unbounded; anything else must parse. */
export const parseSlot = (text: string): {readonly ok: true; readonly slot?: bigint} | {readonly ok: false} => {
  const trimmed = text.trim()
  if (trimmed === '') return {ok: true}
  if (!/^\d+$/.test(trimmed)) return {ok: false}
  return {ok: true, slot: BigInt(trimmed)}
}

export type SlotBoundMode = 'picker' | 'slot'

/**
 * @param ready whether the slot↔time anchor is resolved for the active network
 * @param text the bound as the screen holds it — a slot number, or empty
 * @param date what `text` resolves to, or `null` when it does not resolve
 */
export const slotBoundMode = (ready: boolean, text: string, date: Date | null): SlotBoundMode => {
  if (!ready) return 'slot'
  if (text.trim() === '') return 'picker'
  return date === null ? 'slot' : 'picker'
}
