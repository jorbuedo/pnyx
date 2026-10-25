/**
 * Asking someone for funds: the link a Receive screen hands out.
 *
 * **Two standards, and the request picks the smaller one that can carry it.**
 *
 * - **CIP-13** (`web+cardano:<address>?amount=`) is the established Cardano payment
 *   URI. Every wallet reads it. An ADA-only request uses it, because reaching for an
 *   extension when the base standard suffices costs compatibility for nothing.
 * - **CIP-157** (`web+cardano://pay/v1/<address>?l=&i=&n=&t=`) is the proposed
 *   extension that adds what CIP-13 predates: native assets, a payment identifier,
 *   and a note. A request needing any of those uses it, because CIP-13 genuinely
 *   cannot express them — Mary shipped after it.
 *
 * Neither carries a network, and that is deliberate in both: a Cardano address states
 * its own network in its bytes, so the reader checks the address rather than a claim
 * beside it, and there is no way for the two to disagree.
 *
 * @module
 */

import {build, type PayUri, type PayV1Uri, type RequestedAsset} from '@pnyx/links'

export type FundsRequest = {
  readonly addressBech32: string
  /**
   * Base units (lovelace). `0n` means "any amount" and is carried as an *absent*
   * amount rather than a zero: a request with no amount lets the payer choose, and
   * a literal 0 is a request for nothing.
   */
  readonly lovelace: bigint
  /**
   * Native assets to ask for, by CIP-14 fingerprint. Forces the CIP-157 shape,
   * because CIP-13 cannot name an asset at all.
   */
  readonly assets?: readonly RequestedAsset[] | undefined
  /** A note the payer reads. CIP-157 caps it at 64 characters. */
  readonly note?: string | undefined
  /** An invoice or order reference to be echoed back. */
  readonly paymentId?: string | undefined
}

/** The CIP-157 limit, enforced here so a link is never built that will not parse. */
export const MAX_NOTE_LENGTH = 64

export type FundsRequestProblem =
  | {readonly kind: 'no-address'}
  /** Negative is not a request for a refund; it is a malformed URI. */
  | {readonly kind: 'negative-amount'}
  | {readonly kind: 'note-too-long'}

export type BuiltFundsRequest = {
  readonly ok: true
  readonly link: string
  /** Which standard the link is in, so a caller can say so. */
  readonly standard: 'cip13' | 'cip157'
}

/** The URI, or why it could not be built. */
export const buildFundsRequest = (
  request: FundsRequest,
): BuiltFundsRequest | {readonly ok: false; readonly problem: FundsRequestProblem} => {
  const address = request.addressBech32.trim()
  if (address === '') return {ok: false, problem: {kind: 'no-address'}}
  if (request.lovelace < 0n) return {ok: false, problem: {kind: 'negative-amount'}}
  const note = request.note?.trim()
  if (note !== undefined && note.length > MAX_NOTE_LENGTH) return {ok: false, problem: {kind: 'note-too-long'}}

  const assets = request.assets ?? []
  const paymentId = request.paymentId?.trim()
  const needsExtension =
    assets.length > 0 || (note !== undefined && note !== '') || (paymentId !== undefined && paymentId !== '')

  if (needsExtension) {
    const uri: PayV1Uri = {
      authority: 'pay-v1',
      address,
      ...(request.lovelace > 0n ? {lovelace: request.lovelace} : {}),
      ...(paymentId === undefined || paymentId === '' ? {} : {paymentId}),
      ...(note === undefined || note === '' ? {} : {note}),
      assets,
    }
    return {ok: true, link: build(uri), standard: 'cip157'}
  }

  const uri: PayUri = {
    authority: 'pay',
    address,
    ...(request.lovelace > 0n ? {amount: request.lovelace} : {}),
  }
  return {ok: true, link: build(uri), standard: 'cip13'}
}
