/**
 * Midnight holdings as portfolio rows, so they sit in the same asset list as Cardano's.
 *
 * Pure, and it takes its labels as input rather than reaching for `t()`: the interesting part is which
 * rows exist and what they are worth, and that is what the tests pin.
 *
 * Two rules that are not cosmetic:
 *
 * ⚠️ **Unknown is not zero.** A `null` total means nothing has been read for that rail — no sync yet, or a
 * read that failed — and it produces **no row**. A zero-valued holding produces no row either, but for the
 * opposite reason: the wallet demonstrably holds none. Rendering `0 NIGHT` for the first case would state
 * as fact something nobody checked.
 *
 * ⚠️ **No fiat, ever, for now.** There is no Midnight price source, so `fiatValue` is `null` rather than
 * `0` — a zero would sum into the portfolio total and quietly understate it.
 *
 * @module
 */

import {MIDNIGHT_MAINNET} from '@pnyx/config'
import type {WalletSummary} from '@pnyx/midnight-native'

import type {PortfolioAsset} from '../../cardano-assets/portfolio'
import {midnightAssetId} from './midnight-asset-id'
import {NIGHT_TOKEN_TYPE} from './unshielded-utxo-set'

/** Atomic NIGHT unit. 1 NIGHT = 10⁶ Stars — the same scale the DUST rail states. */
export const NIGHT_DISPLAY_DECIMALS = 6

export type MidnightAssetLabels = {
  /** Sublabel for the transparent rail, e.g. "Unshielded". */
  readonly unshielded: string
  /** Sublabel for the Zswap rail, e.g. "Shielded". */
  readonly shielded: string
}

const hex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

/**
 * A token with no metadata source still has to render as something. Its type is all we know, so show a
 * short head of it — never a made-up name, and never an empty label that reads as a broken row.
 */
export const midnightTokenLabel = (tokenType: string): string =>
  tokenType === NIGHT_TOKEN_TYPE ? 'NIGHT' : `${tokenType.slice(0, 8)}…`

/** `null` where nothing declares them — the figure is then atomic units, never a guessed scale. */
export const midnightTokenDecimals = (tokenType: string): number | null =>
  tokenType === NIGHT_TOKEN_TYPE ? NIGHT_DISPLAY_DECIMALS : null

const row = (params: {
  readonly id: string
  readonly tokenType: string
  readonly quantity: bigint
  readonly subtitle: string
}): PortfolioAsset => ({
  id: params.id,
  chainId: MIDNIGHT_MAINNET,
  isAda: false,
  isChainNative: params.tokenType === NIGHT_TOKEN_TYPE,
  isNft: false,
  label: midnightTokenLabel(params.tokenType),
  subtitle: params.subtitle,
  decimals: midnightTokenDecimals(params.tokenType),
  quantity: params.quantity,
  // No price source for Midnight. `null`, not 0 — see the module note.
  fiatValue: null,
})

/**
 * Rows for what this wallet holds on Midnight, unshielded first.
 *
 * The two rails stay separate rows rather than one summed NIGHT figure: they are not interchangeable —
 * spending a shielded coin proves a circuit while an unshielded UTxO is an ordinary transfer — and a
 * single number would tell the user they hold something fungible that they do not.
 */
export const midnightPortfolioAssets = (input: {
  /** Atomic totals per unshielded token type. `null` = not read. */
  readonly unshieldedTotals: ReadonlyMap<string, bigint> | null
  /** Shielded totals per colour, as the native summary reports them. `null` = not read. */
  readonly shieldedBalances: WalletSummary['balances'] | null
  readonly labels: MidnightAssetLabels
}): readonly PortfolioAsset[] => {
  const out: PortfolioAsset[] = []

  for (const [tokenType, quantity] of input.unshieldedTotals ?? []) {
    if (quantity <= 0n) continue
    out.push({
      ...row({
        id: midnightAssetId({rail: 'unshielded', tokenType}),
        tokenType,
        quantity,
        subtitle: input.labels.unshielded,
      }),
    })
  }

  for (const balance of input.shieldedBalances ?? []) {
    if (balance.value <= 0n) continue
    const tokenType = hex(balance.color)
    out.push({
      ...row({
        id: midnightAssetId({rail: 'shielded', tokenType}),
        tokenType,
        quantity: balance.value,
        subtitle: input.labels.shielded,
      }),
    })
  }

  return out
}
