/**
 * Programmable-token holdings as ordinary portfolio rows.
 *
 * A holder's programmable token *is* theirs, so it appears in the asset list like anything else —
 * same shape, same icon path, no chrome that implies it is a lesser holding. What differs is how it
 * **moves**, and that belongs at the point of moving it, not next to the number.
 *
 * ⚠️ Two things this must never do, both from `docs/CARDANO_CUSTODY_MODEL.md` §4:
 *
 * - **The locked ADA is not merged into the wallet's ADA.** A smart-wallet UTxO carries lovelace
 *   alongside its tokens, and an ordinary transaction cannot spend it — the address's payment
 *   credential is the deployment's script. Adding it to a spendable total makes every send that
 *   sizes itself against the balance fail at build time.
 * - **Quantities are not summed across policies.** One row per asset, keyed by policy and name, the
 *   way a native asset is.
 *
 * @module
 */

import {Cip67} from '@evolution-sdk/cips'
import {logger} from '../../../logger'
import {decodeAssetName} from '../../cardano-assets/asset-name'
import type {PortfolioAsset} from '../../cardano-assets/portfolio'
import type {ProgrammableRow} from './smart-wallet'

/**
 * Flatten holdings into one {@link PortfolioAsset} per asset, so every surface that already renders
 * the portfolio renders these too — one implementation, not one per screen.
 *
 * The id is `policy.name`, matching how a native asset is keyed everywhere else, so the icon and
 * detail paths work without knowing this token is programmable.
 *
 * `fiatValue` is `null` rather than `0`: nothing prices these, and a zero reads as "worthless"
 * rather than "unpriced" (Fallback Value Policy). `decimals` is `null` for the same reason — no
 * source has stated a scale, and assuming 0 would render 1,000,000 for a token that might be 1.0.
 */
export const programmableAssetRows = (holdings: readonly ProgrammableRow[]): readonly PortfolioAsset[] => {
  const byAsset = new Map<string, {label: string; quantity: bigint}>()
  for (const holding of holdings) {
    for (const token of holding.tokens) {
      // ⚠️ A companion asset is not a holding. CIP-113's `no_escape` forbids any token of a
      // registered policy from leaving the PLB — **including** a CIP-68 reference NFT, so unlike
      // everywhere else on Cardano it cannot sit at a reference-token address and instead lives in
      // the holder's own smart wallet, co-resident with their tokens. Rendering it would show
      // someone a phantom unit of their own token's metadata.
      //
      // `fromLabel` returns `undefined` for an unlabelled name, which is every live preview policy
      // today, so this filter is safe against tokens that carry no label at all.
      if (isCompanionAsset(token.assetNameHex)) continue
      const id = `${token.policyIdHex}.${token.assetNameHex}`
      const existing = byAsset.get(id)
      // Several smart-wallet UTxOs can hold the same asset; the holder has one balance in it.
      byAsset.set(id, {
        label: existing?.label ?? decodeAssetName(token.assetNameHex) ?? token.assetNameHex,
        quantity: (existing?.quantity ?? 0n) + token.amount,
      })
    }
  }
  return [...byAsset.entries()].map(([id, {label, quantity}]) => ({
    id,
    isAda: false,
    isNft: false,
    isProgrammable: true,
    label,
    decimals: null,
    quantity,
    fiatValue: null,
  }))
}

/**
 * The portfolio with an account's programmable holdings folded in.
 *
 * One helper rather than a merge per screen: the Wallets widget and the Assets screen build their
 * lists independently, and the first cut of this only wired the widget — so the full list, which is
 * where someone goes to *look for* a token, was the one place it did not appear.
 *
 * Any state other than `ready` contributes nothing. `unavailable` in particular must not invent an
 * empty list: the portfolio it is folded into is real, and a failed side-read should not be able to
 * say anything about it either way.
 */
export const withProgrammable = (
  assets: readonly PortfolioAsset[],
  holdings: {readonly kind: string; readonly rows?: readonly ProgrammableRow[]},
): readonly PortfolioAsset[] =>
  holdings.kind === 'ready' && holdings.rows !== undefined
    ? [...assets, ...programmableAssetRows(holdings.rows)]
    : assets

const COMPANION_LABELS: ReadonlySet<number> = new Set([Cip67.LABEL_REFERENCE_NFT])

const hexToBytes = (hex: string): Uint8Array => {
  const out = new Uint8Array(Math.floor(hex.length / 2))
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return out
}

/**
 * Whether an asset name is a CIP-67 companion rather than the holder's own token.
 *
 * Only the reference NFT (label 100) is excluded. A user FT (333) or user NFT (222) **is** the
 * holding and must keep rendering — excluding by "has any label" would hide the token itself for
 * any issuer who labels theirs.
 */
export const isCompanionAsset = (assetNameHex: string): boolean => {
  try {
    const label = Cip67.fromLabel(hexToBytes(assetNameHex))
    return label !== undefined && COMPANION_LABELS.has(label)
  } catch (e: unknown) {
    // `false` is also "not a companion label", the ordinary answer for most assets.
    logger.debug('Asset name could not be read as a CIP-67 label', {
      origin: 'cip113/programmable-rows',
      error: String(e),
    })
    return false
  }
}
