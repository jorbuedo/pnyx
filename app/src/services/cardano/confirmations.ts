/**
 * Confirmation counting — pure, so it can be tested without the provider or the
 * React tree that supplies the tip.
 *
 * @module
 */

/**
 * Confirmations for a transaction in block `txHeight`, counting its own block as
 * the first.
 *
 * `null` when either height is unknown, and also when the tip is *behind* the
 * transaction. That case is not a rounding error: it means the tip read is stale
 * or belongs to another network, and reporting `0` or a negative count would
 * state something false about how settled the transaction is.
 */
export const confirmationsFor = (tipHeight: number | null, txHeight: number | undefined): number | null => {
  if (tipHeight === null || txHeight === undefined) return null
  if (!Number.isFinite(tipHeight) || !Number.isFinite(txHeight)) return null
  const count = tipHeight - txHeight + 1
  return count >= 1 ? count : null
}
