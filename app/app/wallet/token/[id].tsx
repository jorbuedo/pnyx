/**
 * Token detail, dispatched by chain.
 *
 * A Midnight id matches nothing the Cardano screen resolves — not its metadata, not its portfolio row, not
 * its history — so the route picks the screen rather than the screen growing a second chain's branches.
 */

import {useLocalSearchParams} from 'expo-router'
import {TokenDetailScreen} from '../../../src/screens/cardano/TokenDetailScreen'
import {MidnightTokenDetailScreen} from '../../../src/screens/midnight/MidnightTokenDetailScreen'
import {isMidnightAssetId} from '../../../src/services/midnight/wallet/midnight-asset-id'

export default function TokenDetailRoute() {
  const {id} = useLocalSearchParams<{id?: string}>()
  const assetId = id === undefined ? '' : decodeURIComponent(id)
  return isMidnightAssetId(assetId) ? <MidnightTokenDetailScreen /> : <TokenDetailScreen />
}
