/**
 * The icon for one asset row, in a list that mixes chains.
 *
 * **Every** off-chain row is badged, and the chain's own money is no exception. NIGHT exists on *both*
 * chains — Midnight's native token and Cardano's cNIGHT — so an unbadged NIGHT row would be genuinely
 * ambiguous about which of the two the user is looking at. That is precisely what the badge is for.
 *
 * What the native case changes is the *main* icon, not the badge: the chain's logo stands in for the token,
 * because `TokenIcon` has no icon for a Midnight asset id and the row otherwise showed bare fallback
 * letters beside every properly-iconed Cardano row.
 *
 * Cardano rows are unchanged and unbadged: it is the default chain, and badging the majority of rows
 * would make the badge mean "row" rather than "chain".
 *
 * @module
 */

import {CARDANO_MAINNET, type ChainId} from '@pnyx/config'

import {ChainBadge} from './ChainBadge'
import {hasNetworkIcon, NetworkIcon} from './NetworkIcon'
import {TokenIcon} from './TokenIcon'

export type AssetIconProps = {
  readonly assetId: string
  /** Forwarded to `TokenIcon`, which uses it to skip the CDN for a shipped NFT placeholder. */
  readonly isNft?: boolean
  readonly label: string
  readonly chainId?: ChainId | undefined
  /** True for the chain's native asset — see the module note. */
  readonly isChainNative?: boolean | undefined
  readonly size?: number
  readonly testID?: string
}

export const AssetIcon = ({assetId, label, chainId, isChainNative, size = 36, isNft, testID}: AssetIconProps) => {
  const offChain = chainId !== undefined && chainId !== CARDANO_MAINNET
  const native = offChain && isChainNative === true && hasNetworkIcon(chainId)
  return (
    <ChainBadge chain={chainId} testID={testID}>
      {native ? (
        <NetworkIcon chain={chainId} size={size} />
      ) : (
        <TokenIcon assetId={assetId} label={label} size={size} {...(isNft === true ? {isNft: true} : {})} />
      )}
    </ChainBadge>
  )
}
