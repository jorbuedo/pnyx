/**
 * Reading a `balanceUnsealedTransaction` request.
 *
 * The API's shape is `(tx: string, options?: {payFees?: boolean}) => Promise<{tx: string}>`, where `tx`
 * is a hex-encoded `Transaction<SignatureEnabled, Proof, PreBinding>`. Nothing here touches a wallet or
 * a transaction: it decides whether the *request* is one this wallet could honour, which is why every
 * refusal below is testable without a device.
 *
 * ⚠️ **What this deliberately does not check.** Whether the transaction is actually unsealed, what it
 * owes, and whether its intents can be extended are all facts only the ledger can state — they are
 * decided natively, against the bytes. Guessing at them from the hex here would put a second,
 * disagreeing opinion in front of the real one.
 *
 * @module
 */

import {invalidRequest} from '../resolver.js'
import type {WireError} from '../types.js'

export type BalanceRequest = {
  /** Lowercased hex of the dApp's transaction. */
  readonly txHex: string
  /**
   * Whether the **wallet** is being asked to cover fees.
   *
   * Carried through rather than pinned: the device can pay its own way now, but whether it can *right
   * now* needs a synced DUST state, which this module cannot see. The host answers, and refuses with a
   * stated reason when it cannot.
   */
  readonly payFees: boolean
}

export type BalanceRead =
  | {readonly ok: true; readonly request: BalanceRequest}
  | {readonly ok: false; readonly error: WireError}

const HEX = /^[0-9a-fA-F]+$/

export const readBalanceRequest = (params: unknown): BalanceRead => {
  const args = Array.isArray(params) ? params : []
  const [rawTx, rawOptions] = args
  const no = (error: WireError): BalanceRead => ({ok: false, error})

  if (typeof rawTx !== 'string' || rawTx === '') {
    return no(invalidRequest('balanceUnsealedTransaction takes a hex-encoded transaction'))
  }
  if (rawTx.length % 2 !== 0 || !HEX.test(rawTx)) {
    return no(invalidRequest('balanceUnsealedTransaction takes a hex-encoded transaction'))
  }

  const payFees = (rawOptions as {payFees?: unknown} | undefined)?.payFees
  if (payFees !== undefined && typeof payFees !== 'boolean') {
    return no(invalidRequest(`payFees must be a boolean, not '${String(payFees)}'`))
  }

  // Defaults to true, as the API specifies.
  return {ok: true, request: {txHex: rawTx.toLowerCase(), payFees: payFees ?? true}}
}
