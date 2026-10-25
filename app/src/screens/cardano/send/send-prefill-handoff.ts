/**
 * In-memory handoff from a payment request to the send flow.
 *
 * Same shape and the same reasons as `scanned-request-handoff`: a request arrives
 * from outside the app — a scanned QR, a deep link, a card tapped in a DM — and
 * the send flow has to open with the recipient and amount already in it. Route
 * params would work for an address and a number, but going through one registry
 * keeps a single answer to "where did this prefill come from", which matters
 * because the answer is *untrusted input* in every case.
 *
 * **A prefill is a suggestion, never an instruction.** It fills the fields the
 * user would have typed and stops there: the amount step, the review and the
 * signing ceremony all still happen. Nothing here can move money, and a link that
 * could would be the bug this indirection exists to make obvious.
 *
 * Single-consumer and evicted on claim, so a re-mount cannot silently re-apply a
 * request the user already edited or abandoned.
 *
 * @module
 */

export type SendPrefill = {
  /** Recipient, in the chain's own text form — resolved by the send screen, not here. */
  readonly addressBech32: string
  /**
   * Base units, or `null` for "the sender chooses".
   *
   * `null` rather than `0n`: a request with no amount is an open request, and a
   * zero would prefill the amount step with a send of nothing.
   */
  readonly lovelace: bigint | null
  /** Where it came from, for the audit log and for what the screen says. */
  readonly origin: 'link' | 'scan'
}

const prefills = new Map<string, SendPrefill>()
let counter = 0

/** Register a prefill; returns the id to pass as the `prefill` route param. */
export const registerSendPrefill = (prefill: SendPrefill): string => {
  counter += 1
  const id = `pre_${counter}`
  prefills.set(id, prefill)
  return id
}

/** Take the prefill, removing it. */
export const claimSendPrefill = (id: string): SendPrefill | undefined => {
  const prefill = prefills.get(id)
  prefills.delete(id)
  return prefill
}
