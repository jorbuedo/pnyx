/**
 * `@pnyx/tx-review` — the wallet-aware transaction review IR. One IR, two
 * producers (signing path over a live body; history path from stored data —
 * future), two consumers (the review screen, activity details).
 *
 * Cardano only today; the IR's `chain` discriminant and operation union leave
 * room for other chains.
 *
 * @module
 */

export {LARGE_FEE_LOVELACE, reviewCardanoTx} from './cardano.js'
export {
  type HistoryWalletContext,
  historyDirection,
  type IndexedCardanoTx,
  type IndexedCertificate,
  type IndexedIO,
  type IndexedToken,
  isPureRewardWithdrawal,
  reviewCardanoFromHistory,
  reviewedBlockOf,
} from './history.js'
// Midnight's own view model — a transfer has no UTxO graph, certificates or signature ceremony, so it
// does not share the Cardano IR's shape (see ./midnight.ts).
export {
  type MidnightConfirmView,
  type MidnightDetailView,
  type MidnightFeePayer,
  type MidnightFundingDraft,
  type MidnightFundingLeg,
  type MidnightFundingView,
  type MidnightFundingWarning,
  type MidnightRail,
  type MidnightSettledTransaction,
  type MidnightTransactionDraft,
  type MidnightTransactionNote,
  type MidnightTransactionView,
  type MidnightTransactionWarning,
  type MidnightTransferDraft,
  type MidnightTransferWarning,
  type MidnightTxParty,
  type MidnightTxView,
  reviewMidnightFunding,
  reviewMidnightTransaction,
  reviewMidnightTransfer,
  viewMidnightActivity,
} from './midnight.js'
export {
  type DecryptedShieldedOutput,
  describeMidnightGap,
  type MidnightEffectGap,
  type MidnightTxEffect,
  midnightTxEffect,
} from './midnight-effect.js'
export {
  allUnshielded,
  type MidnightIntentFact,
  type MidnightTxFacts,
  type MidnightUtxoFact,
  readMidnightTxFacts,
} from './midnight-facts.js'
export {type MidnightTxFactsRead, readMidnightTxFactsJson} from './midnight-facts-wire.js'
export {
  addressRef,
  buildGroups,
  classifyCreds,
  counterpartiesOf,
  ioValue,
  ownDeltaValue,
  splitNet,
} from './review-common.js'
export {type ScriptHashSite, type TouchedScript, touchedScripts} from './script-hashes.js'
export {
  bodyNamesStakeScript,
  type ResolvedSigningPaths,
  resolveCardanoSigningPaths,
  ScriptIndexMismatchError,
  type ScriptSpendAuthority,
  type ScriptStakeSpendAuthority,
} from './signing-paths.js'
export type {
  AddressGroup,
  AddressRef,
  CardanoOperation,
  InputRef,
  Outpoint,
  OwnedSigningKey,
  OwnershipLevel,
  PartyAggregate,
  ResolvedInput,
  ReviewedAmount,
  ReviewedAnchor,
  ReviewedBlock,
  ReviewedCollateral,
  ReviewedCredential,
  ReviewedDelta,
  ReviewedDRep,
  ReviewedGovAction,
  ReviewedGovActionId,
  ReviewedIO,
  ReviewedMintAsset,
  ReviewedOperation,
  ReviewedProposal,
  ReviewedTransaction,
  ReviewedVkeyWitness,
  ReviewedVote,
  ReviewedVoter,
  ScriptSummary,
  TransactionWarning,
  WalletContext,
} from './types.js'
export {addAmount, addValue, COIN, emptyValue, fromTokens, toAmounts, type ValueMap} from './value.js'
