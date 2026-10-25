// Pure helpers for the on-device-proving submit seam (client.ts `submitProven`), split out so
// they are unit-testable without a wallet, a proof server, or the ledger WASM.
//
// The device ships a PROVEN, SIGNATURE-ENABLED, PRE-BINDING transaction: proving happened
// on-device, but the fee is not yet bound because the SPONSOR wallet — not the user — balances
// and binds the DUST fee. That marker triple is exactly what `Transaction.deserialize` needs and
// what `WalletProvider.balanceTx` accepts (it returns a finalized/bound tx for `submitTx`).

/**
 * Ledger tx (de)serialization markers for a proven-but-unbound transaction —
 * `Transaction<SignatureEnabled, Proof, PreBinding>`. Passed to
 * `Transaction.deserialize(markerS, markerP, markerB, bytes)` (marker params are these literal
 * `instance` strings, not class instances).
 */
export const PROVEN_TX_MARKERS = ['signature', 'proof', 'pre-binding'] as const

/** Transaction applied successfully on-chain — the only `TxStatus` we treat as a confirmed submit. */
export const TX_SUCCESS = 'SucceedEntirely'

/** True when a finalized transaction's on-chain status is a full success. */
export const isTxSuccess = (status: string): boolean => status === TX_SUCCESS

/**
 * Validate the raw bytes handed to `submitProven` before touching the ledger WASM: reject an empty
 * or non-`Uint8Array` payload with a clear message instead of a deserialization panic. Returns the
 * bytes unchanged when valid, throws otherwise.
 */
export const validateProvenTxBytes = (txBytes: unknown): Uint8Array => {
  if (!(txBytes instanceof Uint8Array)) {
    throw new Error('submitProven: expected a Uint8Array of serialized transaction bytes')
  }
  if (txBytes.length === 0) {
    throw new Error('submitProven: transaction bytes are empty')
  }
  return txBytes
}
