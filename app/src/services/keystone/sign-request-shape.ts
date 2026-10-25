/**
 * Whether a device gets the transaction body or only its hash, as a pure decision.
 *
 * A Keystone answers two request shapes, and the choice is forced by the transaction rather than
 * preferred:
 *
 * - **`cardano-sign-request` (2202)** carries the body. The device parses it, shows its holder the
 *   outputs and the fee, and signs what it displayed. Always better when it is possible.
 * - **`cardano-sign-tx-hash-request` (2212)** carries 32 bytes. The device shows a hash and the paths
 *   it will sign with, and nothing about what the transaction does.
 *
 * ⚠️ **2212 exists because a script or multisig transaction cannot be sent as a body.** Firmware that
 * cannot parse the witness set refuses the request outright, so for CIP-1854 spends — the whole point
 * of `extraSigners` — the hash request is not a shortcut, it is the only thing that works. Gero's
 * implementation reaches the same conclusion through `sdk.cardano.checkNeedSignTxHash`.
 *
 * ## What makes hash-signing acceptable here, and it is not the device
 *
 * The device's screen is *not* the safeguard in this direction; ours is:
 *
 * 1. **We built the transaction**, so its contents are known before anything is displayed.
 * 2. **Our own review screen shows it in full** before a QR is emitted — the same review a software
 *    wallet's own spend goes through.
 * 3. **`verifyWitnessSignatures` re-checks every returned witness** against the *reviewed* body hash,
 *    under its own vkey. A device that signed a different hash produces a witness we reject.
 *
 * Remove any one of those and this becomes blind signing. That is why this module returns the reason
 * for its choice: a caller that cannot say why it is sending a hash should not send one.
 *
 * ⚠️ **The inbound refusal is unaffected and must stay.** Being *asked* to sign a bare hash means
 * handing out a witness for bytes nobody reviewed — a Cardano vkey witness *is* a signature over a
 * 32-byte body hash. `scan-routing.ts` refuses 2212 by name, and the asymmetry is the whole design.
 *
 * @module
 */

/** What a transaction carries that decides the request shape. */
export type TransactionShape = {
  /**
   * Whether the witness set already holds anything — another party's vkey witness, a native script,
   * a Plutus script or datum.
   *
   * ⚠️ This is the condition, not "is it multisig". A partially-signed CIP-1854 spend is the common
   * case, but any pre-populated witness set makes the body unparseable to firmware.
   */
  readonly witnessSetPopulated: boolean
  /** Whether the body names required extra signatures — set by DEX and contract interactions. */
  readonly requiresExtraSignatures: boolean
}

export type SignRequestShape =
  /** Send the body. The device shows the transaction and signs what it showed. */
  | {readonly kind: 'body'}
  /**
   * Send the hash. `reason` is caller-facing and names *why* the body was impossible — it belongs on
   * the review screen, because a user consenting to hash-signing should be told the device will show
   * them less than the phone just did.
   */
  | {readonly kind: 'hash'; readonly reason: string}

/**
 * Which shape this transaction must be sent as.
 *
 * Body unless the body cannot work. The order matters only for the message: a transaction that is both
 * script-bearing and names required signers is reported by the condition a reader can act on.
 */
export const signRequestShapeFor = (transaction: TransactionShape): SignRequestShape => {
  if (transaction.witnessSetPopulated) {
    return {
      kind: 'hash',
      reason:
        'this transaction already carries witnesses or scripts, which a hardware device cannot parse ' +
        'as a body — it will show a hash and the keys it signs with, not the transaction',
    }
  }
  if (transaction.requiresExtraSignatures) {
    return {
      kind: 'hash',
      reason:
        'this transaction names required extra signatures, which a hardware device cannot satisfy from ' +
        'a body request — it will show a hash and the keys it signs with, not the transaction',
    }
  }
  return {kind: 'body'}
}
