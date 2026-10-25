/**
 * Turning a payment request into a send-flow prefill.
 *
 * **The network is not checked here, deliberately.** A Cardano address states its
 * own network in its bytes, and `resolveRecipient` — which the send screen runs on
 * every recipient — already checks it against the rail and reports `wrong-network`
 * with copy that says exactly that. Repeating the check here would be a second
 * answer to one question, and a weaker one: this layer would have to guess from a
 * bech32 prefix, which cannot tell preprod from preview. CIP-13 carries no chain
 * field for the same reason.
 *
 * So this only refuses a request with nothing to pay *to*, and everything else
 * lands on the send screen where the address is validated for real.
 *
 * Pure, so the refusals need no running app to test.
 *
 * @module
 */

import type {SendPrefill} from '../screens/cardano/send/send-prefill-handoff'

/**
 * A prefill for the send flow, or `null` when there is no address to pay.
 *
 * A zero amount is carried as "no amount": a request for nothing is an open
 * request, not a send of 0.
 */
export const paymentPrefillFor = (
  address: string,
  lovelace: bigint | null,
  origin: SendPrefill['origin'] = 'scan',
): SendPrefill | null => {
  const addressBech32 = address.trim()
  if (addressBech32 === '') return null
  return {addressBech32, lovelace: lovelace === null || lovelace <= 0n ? null : lovelace, origin}
}
