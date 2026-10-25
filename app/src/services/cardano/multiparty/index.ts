/** Multiparty (multi-input-wallet co-funding) support. @module */

export {
  type BuiltMultiparty,
  buildMultipartyTx,
  MultipartyBuildError,
  type MultipartyRecipient,
} from './build'
export {
  type AssetMap,
  type ComposedMultiparty,
  type ComposeFailure,
  type ComposeResult,
  type ContributedUtxo,
  type Contribution,
  composeMultiparty,
  type MinAdaFor,
  type PartyPlan,
} from './compose'
export {contributableTotal, GatherError, gatherContributableUtxos} from './gather'
export {
  type LocalMultipartySigner,
  type LocalWallet,
  localMultipartySignersOf,
  outstandingMultipartySigners,
} from './local-signers'
export {type ContributingWallet, extractRequiredSigners, type ResolvedInputAddress} from './model'
