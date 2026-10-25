import type {TransactionData} from './unified-transaction.js'

export type TransactionNftSignals = Pick<TransactionData, 'nftTransfers' | 'hasNft' | 'type' | 'metadata'>

/**
 * Whether a transaction involves an NFT transfer.
 *
 * List rows carry {@link TransactionData.hasNft} from the indexed store column;
 * detail rows may populate {@link TransactionData.nftTransfers}. Classified
 * `type: 'nft'` and `metadata.nft` cover persisted hints when transfers are not
 * projected onto the list shape.
 */
export const transactionInvolvesNft = (tx: TransactionNftSignals): boolean =>
  (tx.nftTransfers?.length ?? 0) > 0 || tx.hasNft === true || tx.type === 'nft' || tx.metadata?.nft === true
