/**
 * Which chains one of your own wallets can be paid on.
 *
 * Its own module because it is the rule, not the rendering: a hardware wallet has no Midnight
 * address, and neither does a read-only or a multisig wallet — those addresses are derived from a
 * seed at create/restore, and those wallets never had one to derive from. Listing a Midnight row for
 * a Ledger would offer an address that does not exist.
 *
 * Cardano is offered for every wallet, including hardware and read-only: they all have a Cardano
 * address, and paying one is exactly what an address book is for.
 *
 * @module
 */

import {CARDANO_MAINNET, type ChainId, MIDNIGHT_MAINNET} from '@pnyx/config'

/**
 * The part of a wallet this rule reads.
 *
 * A structural type rather than the app's `WalletGroup`, so the rule can be tested without
 * constructing one — and so it keeps working when unrelated fields on that type move.
 */
export type OwnWalletShape = {
  readonly primaryWallet?:
    | {
        readonly isHardware?: boolean | undefined
        readonly implementation?: string | undefined
        readonly source?: string | undefined
      }
    | undefined
}

/**
 * True when this wallet's addresses come from a seed this app holds.
 *
 * The same three conditions `useMidnightUnshieldedAddress` applies before it will even look for an
 * address. Kept in one place because two spellings of "seed-backed" is how one surface offers an
 * address another cannot produce.
 */
export const isSeedBacked = (group: OwnWalletShape): boolean => {
  const primary = group.primaryWallet
  return (
    primary !== undefined &&
    primary.isHardware !== true &&
    primary.implementation !== 'readOnly' &&
    primary.source !== 'multisig'
  )
}

/** The chains to offer for this wallet, in display order. */
export const ownWalletChains = (group: OwnWalletShape): readonly ChainId[] =>
  isSeedBacked(group) ? [CARDANO_MAINNET, MIDNIGHT_MAINNET] : [CARDANO_MAINNET]
