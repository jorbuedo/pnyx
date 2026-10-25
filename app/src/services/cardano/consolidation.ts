/**
 * UTxO consolidation: folding a scattered UTxO set into a few dense outputs, so
 * a wallet that cannot fit a send in one transaction can again.
 *
 * @module
 */

export {
  buildConsolidation,
  ConsolidationError,
  type ConsolidationLeg,
  type ConsolidationOutcome,
  consolidationAssetOutputs,
  consolidationSignerCount,
  foldConsolidationLegs,
  MAX_CONSOLIDATION_LEGS,
} from './consolidation/build'
export {
  type ConsolidationCandidates,
  type ExclusionReason,
  isPureAda,
  orderAssetsForPacking,
  reducesUtxoCount,
  selectConsolidationCandidates,
  totalAssets,
  totalLovelace,
} from './consolidation/plan'
export {DEFAULT_WALLET_OPTIMIZATION, type WalletOptimization} from './consolidation/policy'
export {
  decodeWalletOptimization,
  loadWalletOptimization,
  saveWalletOptimization,
  WALLET_OPTIMIZATION_KEY,
} from './consolidation/store'
