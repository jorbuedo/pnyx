/**
 * The addresses a wallet holds that no key of ours derives, read off the group records.
 *
 * ⚠️ **Why this exists at all.** The address table has no migration framework — on a
 * schema-version mismatch it drops and recreates — and its contract says chain sync
 * repopulates it. That holds only for wallets whose addresses are *derived*: an HD
 * wallet's book comes back from its xpub whenever discovery runs. A shared wallet's
 * compiled script address and a watch-only import were written once, at creation, and
 * never again. The first schema bump would have left those wallets with no address at
 * all, and receive, the co-sign screen and the rail all resolve theirs from storage.
 *
 * Keeping them on the group record makes the table a cache for every wallet kind rather
 * than the sole copy for two of them.
 *
 * Pure over the group map so it can be tested without standing up the service.
 *
 * @module
 */

import type {ChainId} from '@pnyx/config'
import type {WalletGroup, WalletGroupId} from '@pnyx/wallet'

/** One address that has to exist in the table, and where it came from. */
export type NonDerivedAddress = {
  readonly groupId: WalletGroupId
  readonly chainId: ChainId
  /** Position in the group's list — the `external` branch index the row takes. */
  readonly index: number
  readonly human: string
  /** For logging: which kind of wallet put it there. */
  readonly source: string
}

/**
 * Every non-derived address across the given groups, in group → chain → list order.
 *
 * Empty for an ordinary wallet: `nonDerivedAddresses` is absent unless a creator that
 * had no key to derive from recorded it.
 */
export const nonDerivedAddresses = (groups: ReadonlyMap<WalletGroupId, WalletGroup>): readonly NonDerivedAddress[] => {
  const out: NonDerivedAddress[] = []
  for (const [groupId, group] of groups) {
    for (const [chainId, chainConfig] of group.chains) {
      const addresses = chainConfig.nonDerivedAddresses ?? []
      for (const [index, human] of addresses.entries()) {
        // A blank entry is not an address, and writing one would put a row nothing can
        // resolve in front of the readers this exists to serve.
        if (human.trim().length === 0) continue
        out.push({groupId, chainId, index, human, source: group.source})
      }
    }
  }
  return out
}
