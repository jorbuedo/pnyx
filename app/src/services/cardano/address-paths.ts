/**
 * Join persisted address rows to their CIP-1852 derivation paths, so a screen
 * holding only bech32 addresses (the rail's UTxOs, a review row) can say *which*
 * of our addresses it is looking at. Pure.
 *
 * @module
 */

import type {AddressRow} from '@pnyx/store/address-table'
import {cardanoAddressPath} from './account'

/**
 * `bech32 → m/1852'/1815'/<acct>'/<0|1>/<index>` for every row that has both a
 * bech32 form and a role. Cardano rows are `external`/`internal`; a `single` row
 * has no role to encode, so it is left out rather than assigned one.
 */
export const derivationPathsByAddress = (rows: readonly AddressRow[]): ReadonlyMap<string, string> => {
  const paths = new Map<string, string>()
  for (const row of rows) {
    if (typeof row.human !== 'string' || row.human === '') continue
    if (row.branch !== 'external' && row.branch !== 'internal') continue
    paths.set(row.human, cardanoAddressPath(row.accountIndex, row.branch, row.index))
  }
  return paths
}

/**
 * The address set a rail should cover, from the persisted book.
 *
 * ⚠️ **`isUsed` gates `knownUsed` and nothing else.** It records what the *last* gap scan
 * saw, so a row still marked unused may already hold coins — a deposit that landed after
 * that scan. Excluding such a row from {@link RailAddressSet.paths} drops its payment
 * credential from the UTxO query, and an output the wallet owns is then never asked
 * about: it does not show as zero, it does not show at all. `knownUsed` keeps the filter
 * because its only job is making the next scan cheaper.
 *
 * Pure, and its own function rather than inline in `useCardanoRail`, so the rule above is
 * a thing a test can pin instead of a thing a hook happens to do.
 */
export type RailAddressSet = {
  /** `bech32 → CIP-1852 path` for every derived row, used or not. */
  readonly paths: ReadonlyMap<string, string>
  /** Addresses a previous scan proved used — the gap scan's cost reducer. */
  readonly knownUsed: readonly string[]
  /** Every derived address except the primary, i.e. the rail's `extraAddresses`. */
  readonly beyondPrimary: readonly string[]
}

export const railAddressSetFromRows = (rows: readonly AddressRow[], primary: string): RailAddressSet => {
  const paths = derivationPathsByAddress(rows)
  return {
    paths,
    knownUsed: rows
      .filter((row) => row.isUsed)
      .map((row) => row.human)
      .filter((human): human is string => typeof human === 'string'),
    beyondPrimary: [...paths.keys()].filter((bech32) => bech32 !== primary),
  }
}

/**
 * A short, order-independent fingerprint of a path map, for the rail cache key.
 *
 * ⚠️ **The key carried `paths.size`**, so two different address sets of equal size shared
 * one rail — and whichever caller arrived second silently got the first one's UTxO scope.
 * A bech32 address is derived from its path, so the pair list *is* the identity of the
 * set; this digests it rather than embedding it, because a 664-credential wallet's joined
 * pairs run to tens of kilobytes and a cache key is held for the life of the process.
 *
 * Not a security primitive and must never be used as one: FNV-1a and djb2 over the sorted
 * pairs, reported alongside the count, so a collision needs both digests *and* the size to
 * agree. Pairs are newline-joined before hashing — without a separator, two different sets
 * can concatenate to the same byte stream.
 */
export const addressPathsFingerprint = (paths: ReadonlyMap<string, string> | undefined): string =>
  paths === undefined ? '0' : stringsFingerprint([...paths.entries()].map(([bech32, path]) => `${bech32}=${path}`))

/**
 * The same digest over a bare set of strings — the shape the rail's address *coverage* takes.
 *
 * Order-independent and duplicate-insensitive, because both describe the same covered set.
 */
export const stringsFingerprint = (values: Iterable<string>): string => {
  const unique = [...new Set(values)].sort()
  if (unique.length === 0) return '0'
  const joined = unique.join('\n')
  let fnv = 0x811c9dc5
  let djb = 5381
  for (let i = 0; i < joined.length; i++) {
    const c = joined.charCodeAt(i)
    fnv = Math.imul(fnv ^ c, 0x01000193) >>> 0
    djb = (Math.imul(djb, 33) + c) >>> 0
  }
  return `${unique.length}.${fnv.toString(36)}.${djb.toString(36)}`
}
