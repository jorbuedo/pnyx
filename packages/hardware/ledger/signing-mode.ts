/**
 * Which mode Ledger should be asked to sign a Cardano transaction in.
 *
 * Pure, and its own module, because the decision is the interesting part and the
 * device it belongs to cannot be brought into a test.
 *
 * | transaction | mode |
 * |---|---|
 * | caller says it is one co-signer's share | `multisig_transaction` |
 * | script data hash, or collateral inputs | `plutus_transaction` |
 * | several signing paths **and** `required_signers`, no Plutus features | `multisig_transaction` |
 * | anything else | `ordinary_transaction` |
 *
 * The first row exists because the rows below it cannot see a CIP-1854 spend.
 * That transaction carries exactly one signing path — our own key — and names
 * the keys it needs in the *script*, not in the body's `required_signers`. Both
 * inference tests therefore miss it, the device is asked for an ordinary
 * signature, and it then rejects the 1854 path and finds no witness path in a
 * script input. The caller has never had to guess: it knows it is spending from
 * a script wallet.
 *
 * @module
 */

export type LedgerSigningMode = 'ordinary_transaction' | 'plutus_transaction' | 'multisig_transaction'

export const ledgerSigningModeFor = (args: {
  /** The caller's declaration that this is one co-signer's share. */
  readonly multisig?: boolean
  /** Body key 11 — Plutus script data. */
  readonly hasWitnessHash: boolean
  /** Body key 13 — collateral, required for Plutus. */
  readonly hasCollateralInputs: boolean
  /** Body key 14 — `required_signers`. */
  readonly hasRequiredSigners: boolean
  readonly signingPathCount: number
}): LedgerSigningMode => {
  // Stated beats inferred, and is checked first so nothing below can talk it
  // down: the escalations exist to find a mode that can represent the
  // transaction, and this is already the one that represents it.
  if (args.multisig === true) return 'multisig_transaction'
  if (args.hasWitnessHash || args.hasCollateralInputs) return 'plutus_transaction'
  if (args.signingPathCount > 1 && args.hasRequiredSigners) return 'multisig_transaction'
  return 'ordinary_transaction'
}
