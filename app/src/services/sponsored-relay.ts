/**
 * Handing a device-proven transaction to the sponsor, through `POST /register`.
 *
 * One relay for every transaction of this shape — an identity shell deploy, an identity row write, and
 * now the three of a handle claim — because they are the same arrangement: the device authors and
 * proves, the service pays the fee and submits, and it cannot author any of them. `/register` is
 * unauthenticated for exactly this reason: it is what bootstraps authentication, so nothing it could
 * require exists yet (`docs/PNYX_IDENTITY_PLAN.md` → Bootstrap).
 *
 * ⚠️ **The route decides nothing about which transactions it will pay for.** It hands the bytes to
 * `submitProven`, which recognises each call's contract by **code digest** and checks its entry point
 * against that template's allowlist — so what is fundable is a property of the sponsorship policy, not
 * of this endpoint. That is why a handle claim needs no new route: `payment` and `handle` were added to
 * the policy on 2026-08-26.
 *
 * ⚠️ It is also why the name matters. This was `identity-relay.ts` with `relayIdentityTx`, and a handle
 * claim going through a function named for identity would have been a lie in the one place a reader
 * looks to find out what an endpoint is for. Renamed rather than copied — a second copy would have been
 * a second place for the refusal-body handling below to rot, and that body is the only diagnosis a
 * caller gets.
 *
 * @module
 */

import {logger} from '../logger'
import {serviceUrl} from './pnyx-session'

const ORIGIN = 'sponsored-relay'

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** The relay refused, or could not be reached. Carries the service's own reason where there is one. */
export class SponsoredRelayError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
    cause?: unknown,
  ) {
    super(message)
    this.cause = cause
    this.name = 'SponsoredRelayError'
  }
}

/**
 * Relay one proven, unbalanced transaction. Resolves when the service has **accepted it for submission**
 * — not when it is on chain. A caller that needs the chain to agree has to read the chain.
 */
export const relaySponsoredTx = async (tx: Uint8Array): Promise<void> => {
  let response: Response
  try {
    response = await fetch(`${serviceUrl()}/register`, {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({tx: toBase64(tx)}),
    })
  } catch (error) {
    logger.warn('the registration relay was unreachable', {origin: ORIGIN, error: String(error)})
    throw new SponsoredRelayError(undefined, 'could not reach the registration endpoint', error)
  }
  if (response.ok) return
  // The service puts the reason in the body; a status alone is not a diagnosis, and this is the last
  // place it exists — nothing downstream of the throw can go back and read it.
  const detail = await response.text().catch((error: unknown) => {
    logger.warn('registration refusal body could not be read', {
      origin: ORIGIN,
      status: response.status,
      error: String(error),
    })
    return ''
  })
  logger.warn('the registration relay refused', {origin: ORIGIN, status: response.status, detail: detail.slice(0, 200)})
  throw new SponsoredRelayError(
    response.status,
    detail === ''
      ? `registration rejected (${response.status})`
      : `registration rejected (${response.status}): ${detail.slice(0, 400)}`,
  )
}
