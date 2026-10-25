/**
 * Reading a `makeTransfer` request.
 *
 * The API's `DesiredOutput` carries a `bigint` value, which cannot cross a JSON bridge — the injected
 * provider sends it as a decimal string and this parses it back, the mirror of what balances do on the
 * way out. Nothing here touches a wallet: it decides whether a request is one this wallet could
 * possibly honour, so the refusals are testable without a device.
 *
 * ⚠️ **A refusal is better than a substitution at every point below.** A value that is not an integer,
 * a kind that is neither shielded nor unshielded, an output count the builder cannot express — each is
 * a request the dApp can fix once it is told. Rounding a value or picking a kind would build a
 * different transfer than the one asked for, and the user would approve *that* one.
 *
 * @module
 */

import {invalidRequest} from '../resolver.js'
import type {WireError} from '../types.js'

/** One output, in the terms the wallet's builders take. */
export type TransferOutput = {
  readonly kind: 'shielded' | 'unshielded'
  /** 64-hex token type. NIGHT is 32 zero bytes. */
  readonly tokenType: string
  readonly value: bigint
  /** Bech32m, and the wallet checks its network — this only checks it is a non-empty string. */
  readonly recipient: string
}

export type TransferRequest = {
  readonly outputs: readonly TransferOutput[]
  /**
   * Whether the **wallet** is being asked to cover fees.
   *
   * ⚠️ **Not decided here any more.** It used to be pinned to `true`, because Midnight fees are DUST
   * and the phone held none. The device can now pay its own way, but whether it can *right now* depends
   * on a synced DUST state and a priced fee — facts this module cannot see. So the request is carried
   * through and the host answers it, refusing with a stated reason when it cannot.
   *
   * Note the sense: `payFees: false` means the **dApp** intends to pay, so the wallet must produce a
   * transaction that funds itself rather than one a sponsor completes.
   */
  readonly payFees: boolean
  /**
   * Whether the wallet should **submit** after the user approves, rather than hand the bytes back.
   *
   * Defaults to false, which is what a page wants: it submits for itself. A caller with no rail of its
   * own — an AI agent reaching the wallet over MCP — asks for true, so approving sends it and one round
   * trip does the whole job.
   */
  readonly submit: boolean
}

export type TransferRead =
  | {readonly ok: true; readonly request: TransferRequest}
  | {readonly ok: false; readonly error: WireError}

/**
 * How many outputs one transfer can carry.
 *
 * One, because the native builders take a single recipient and value. That is a limit of this wallet
 * rather than of the API, so it is reported as such — a dApp that hears "one output per transfer" can
 * split the request; one that receives a transfer missing its second output cannot.
 */
export const MAX_TRANSFER_OUTPUTS = 1

const HEX_64 = /^[0-9a-fA-F]{64}$/

/** A decimal string from the bridge, back to the `bigint` the API promised the dApp. */
const parseValue = (raw: unknown): bigint | null => {
  if (typeof raw === 'bigint') return raw
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return null
  return BigInt(raw)
}

export const readTransferRequest = (params: unknown): TransferRead => {
  const args = Array.isArray(params) ? params : []
  const [rawOutputs, rawOptions] = args
  const no = (error: WireError): TransferRead => ({ok: false, error})

  if (!Array.isArray(rawOutputs) || rawOutputs.length === 0) {
    return no(invalidRequest('makeTransfer takes at least one desired output'))
  }
  if (rawOutputs.length > MAX_TRANSFER_OUTPUTS) {
    return no(
      invalidRequest(
        `this wallet builds one output per transfer, and this request has ${rawOutputs.length} — send them as separate transfers`,
      ),
    )
  }
  const payFees = (rawOptions as {payFees?: unknown} | undefined)?.payFees
  if (payFees !== undefined && typeof payFees !== 'boolean') {
    return no(invalidRequest(`payFees must be a boolean, not '${String(payFees)}'`))
  }
  const submit = (rawOptions as {submit?: unknown} | undefined)?.submit
  if (submit !== undefined && typeof submit !== 'boolean') {
    return no(invalidRequest(`submit must be a boolean, not '${String(submit)}'`))
  }

  const outputs: TransferOutput[] = []
  for (const raw of rawOutputs as readonly unknown[]) {
    const output = raw as {kind?: unknown; type?: unknown; value?: unknown; recipient?: unknown}
    if (output.kind !== 'shielded' && output.kind !== 'unshielded') {
      return no(invalidRequest(`an output kind is 'shielded' or 'unshielded', not '${String(output.kind)}'`))
    }
    if (typeof output.type !== 'string' || !HEX_64.test(output.type)) {
      return no(invalidRequest('an output needs a 64-hex token type'))
    }
    const value = parseValue(output.value)
    if (value === null) {
      return no(invalidRequest(`an output value must be a non-negative integer, not '${String(output.value)}'`))
    }
    if (value <= 0n) {
      // Zero would build a transfer that moves nothing while still spending inputs and a fee.
      return no(invalidRequest('an output value must be greater than zero'))
    }
    if (typeof output.recipient !== 'string' || output.recipient === '') {
      return no(invalidRequest('an output needs a recipient address'))
    }
    outputs.push({kind: output.kind, tokenType: output.type.toLowerCase(), value, recipient: output.recipient})
  }
  // Defaults to true, as the API specifies.
  return {ok: true, request: {outputs, payFees: payFees ?? true, submit: submit ?? false}}
}
