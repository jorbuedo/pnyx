/**
 * Grouping for the review UTxOs tab: a flat list of `ReviewedIO` becomes
 * "address → the UTxOs at it", so the tab reads as UTxOs held by addresses
 * rather than as a list of addresses with balances. Pure.
 *
 * @module
 */

import type {AddressRef, ReviewedIO} from '@pnyx/tx-review'

export type IoAddressGroup = {
  readonly address: AddressRef
  /** The UTxOs at this address, in the order the transaction lists them. */
  readonly entries: readonly ReviewedIO[]
}

/**
 * Group IOs by address, preserving first-appearance order both of the addresses
 * and of the entries within each. One entry is one UTxO; an entry without an
 * `outpoint` is a not-yet-existing output of the transaction under review.
 */
export const groupIosByAddress = (ios: readonly ReviewedIO[]): readonly IoAddressGroup[] => {
  const order: string[] = []
  const byAddress = new Map<string, {address: AddressRef; entries: ReviewedIO[]}>()
  for (const io of ios) {
    const key = io.address.hex
    const group = byAddress.get(key)
    if (group === undefined) {
      order.push(key)
      byAddress.set(key, {address: io.address, entries: [io]})
    } else {
      group.entries.push(io)
    }
  }
  return order.map((key) => byAddress.get(key) as IoAddressGroup)
}
