/**
 * Transaction classification and summarization.
 *
 * @module
 */

import type {
  TransactionDirection,
  TransactionStatus,
  TransactionSummary,
  WalletTransaction,
  WalletTransactionInput,
  WalletTransactionOutput,
} from '../types.js'

/**
 * Classify transaction direction based on inputs and outputs.
 *
 * Algorithm:
 * 1. Separate own vs foreign inputs/outputs using address set
 * 2. Determine direction:
 *    - 'self': all inputs and outputs are own addresses
 *    - 'sent': has own inputs but some outputs go to foreign addresses
 *    - 'received': no own inputs, has own outputs
 *    - 'multi': complex transaction (e.g., multi-party)
 * 3. Handle failed scripts (validContract=false → 'self')
 */
export const classifyTransaction = (tx: WalletTransaction, ownAddresses: ReadonlySet<string>): TransactionDirection => {
  // Failed scripts return all inputs to original owners
  if (!tx.validContract) {
    return 'self'
  }

  // Categorize inputs and outputs
  const ownInputs = tx.inputs.filter((i) => ownAddresses.has(i.address))
  const foreignInputs = tx.inputs.filter((i) => !ownAddresses.has(i.address))
  const ownOutputs = tx.outputs.filter((o) => ownAddresses.has(o.address))
  const foreignOutputs = tx.outputs.filter((o) => !ownAddresses.has(o.address))

  const hasOwnInputs = ownInputs.length > 0
  const hasForeignInputs = foreignInputs.length > 0
  const hasForeignOutputs = foreignOutputs.length > 0

  // Self transaction: all inputs are ours and no foreign outputs
  if (hasOwnInputs && !hasForeignInputs && !hasForeignOutputs) {
    return 'self'
  }

  // Received: no own inputs, but we have outputs
  if (!hasOwnInputs && ownOutputs.length > 0) {
    return 'received'
  }

  // Multi-party transaction: has foreign inputs AND own inputs
  if (hasOwnInputs && hasForeignInputs) {
    return 'multi'
  }

  // Sent: we have inputs and some outputs go to others
  if (hasOwnInputs && hasForeignOutputs) {
    return 'sent'
  }

  // Default to received if we have any outputs
  if (ownOutputs.length > 0) {
    return 'received'
  }

  // Fallback (shouldn't normally happen)
  return 'multi'
}

/**
 * Calculate net balance change from a transaction.
 *
 * Positive = we gained value
 * Negative = we lost value (including fees)
 */
export const calculateNetChange = (
  tx: WalletTransaction,
  ownAddresses: ReadonlySet<string>,
): {lovelace: bigint; assets: ReadonlyMap<string, bigint>} => {
  let lovelaceIn = 0n
  let lovelaceOut = 0n
  const assetsIn = new Map<string, bigint>()
  const assetsOut = new Map<string, bigint>()

  // Sum our inputs (what we spent)
  for (const input of tx.inputs) {
    if (ownAddresses.has(input.address)) {
      lovelaceIn += input.value.lovelace
      if (input.value.assets) {
        for (const [asset, amount] of input.value.assets) {
          assetsIn.set(asset, (assetsIn.get(asset) ?? 0n) + amount)
        }
      }
    }
  }

  // Sum our outputs (what we received)
  for (const output of tx.outputs) {
    if (ownAddresses.has(output.address)) {
      lovelaceOut += output.value.lovelace
      if (output.value.assets) {
        for (const [asset, amount] of output.value.assets) {
          assetsOut.set(asset, (assetsOut.get(asset) ?? 0n) + amount)
        }
      }
    }
  }

  // Calculate net change
  const lovelaceNet = lovelaceOut - lovelaceIn

  // Calculate net asset changes
  const assetsNet = new Map<string, bigint>()
  const allAssets = new Set([...assetsIn.keys(), ...assetsOut.keys()])
  for (const asset of allAssets) {
    const inAmount = assetsIn.get(asset) ?? 0n
    const outAmount = assetsOut.get(asset) ?? 0n
    const net = outAmount - inAmount
    if (net !== 0n) {
      assetsNet.set(asset, net)
    }
  }

  return {lovelace: lovelaceNet, assets: assetsNet}
}

/**
 * Get own inputs from transaction.
 */
export const getOwnInputs = (
  tx: WalletTransaction,
  ownAddresses: ReadonlySet<string>,
): readonly WalletTransactionInput[] => tx.inputs.filter((i) => ownAddresses.has(i.address))

/**
 * Get own outputs from transaction.
 */
export const getOwnOutputs = (
  tx: WalletTransaction,
  ownAddresses: ReadonlySet<string>,
): readonly WalletTransactionOutput[] => tx.outputs.filter((o) => ownAddresses.has(o.address))

/**
 * Determine transaction status.
 */
export const getTransactionStatus = (tx: WalletTransaction, isPending: boolean): TransactionStatus => {
  if (isPending) {
    return 'pending'
  }
  if (!tx.validContract) {
    return 'failed'
  }
  if (tx.block) {
    return 'confirmed'
  }
  return 'pending'
}

/**
 * Create a transaction summary.
 */
export const createTransactionSummary = (
  tx: WalletTransaction,
  ownAddresses: ReadonlySet<string>,
  options: {
    readonly isPending?: boolean
    readonly confirmations?: number | null
  } = {},
): TransactionSummary => {
  const direction = classifyTransaction(tx, ownAddresses)
  const status = getTransactionStatus(tx, options.isPending ?? false)
  const netChange = calculateNetChange(tx, ownAddresses)
  const ownInputs = getOwnInputs(tx, ownAddresses)
  const ownOutputs = getOwnOutputs(tx, ownAddresses)

  const summary: TransactionSummary = {
    hash: tx.hash,
    direction,
    status,
    confirmations: options.confirmations ?? (tx.block ? 1 : null),
    amount: {
      lovelace: netChange.lovelace < 0n ? -netChange.lovelace : netChange.lovelace,
      assets: netChange.assets,
    },
    fee: tx.fee,
    ownInputs,
    ownOutputs,
  }
  if (tx.block?.time) {
    ;(summary as {timestamp?: Date}).timestamp = tx.block.time
  }
  return summary
}

/**
 * Sort transactions by time (newest first).
 */
export const sortByTime = (transactions: readonly WalletTransaction[]): readonly WalletTransaction[] =>
  [...transactions].sort((a, b) => {
    const timeA = a.block?.time?.getTime() ?? Number.MAX_SAFE_INTEGER
    const timeB = b.block?.time?.getTime() ?? Number.MAX_SAFE_INTEGER
    return timeB - timeA
  })

/**
 * Filter transactions by direction.
 */
export const filterByDirection = (
  transactions: readonly WalletTransaction[],
  ownAddresses: ReadonlySet<string>,
  direction: TransactionDirection,
): readonly WalletTransaction[] => transactions.filter((tx) => classifyTransaction(tx, ownAddresses) === direction)
