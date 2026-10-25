/**
 * Naming a DUST destination, and offering the ones a user can sensibly pick.
 *
 * The destination is a free choice: a NIGHT holder designates any recipient, including one
 * they do not control, which is how delegation and fee sponsorship work. So the wallet's
 * job is not to police it but to *say whose it is* — this wallet, another of the user's
 * wallets, Pnyx, or an address we simply do not recognise. An unrecognised destination is
 * reported as unrecognised, never as wrong.
 *
 * @module
 */

import {encodeDustAddressPayload} from '@pnyx/wallet'
import {dustDonationAddress} from '../../config/env'
import {logger} from '../../logger'
import type {DustAddrPayload} from './registration-health'

/**
 * The datum's `dust_address` payload, rendered as the `mn_dust` address it came from.
 *
 * A registration naming an address we do not own is a *choice*, not an anomaly — so the
 * screen must be able to say which address, not just "somewhere else". `null` when the
 * payload is not a well-formed DUST address, which is the honest answer for a registration
 * written by something other than a conforming wallet.
 *
 * Mainnet-form because that is the only Midnight network this app derives addresses for and
 * the only one the mapping validator is deployed on (see `validator.ts`).
 */
export const dustAddressFromPayload = (payload: DustAddrPayload): string | null => {
  const bytes = payload.match(/../g)?.map((h) => Number.parseInt(h, 16))
  if (bytes === undefined || bytes.length === 0 || bytes.some(Number.isNaN)) return null
  try {
    return encodeDustAddressPayload(Uint8Array.from(bytes), 'mainnet')
  } catch (e: unknown) {
    logger.warn('DUST destination could not be encoded', {origin: 'midnight-dust/destination', error: String(e)})
    return null
  }
}

/**
 * Pnyx's own DUST address, offered as a donation for users with no use for their own DUST
 * — it funds the community features the app sponsors.
 *
 * Env-driven and **absent by default**. When unset the donation option is simply not
 * offered; there is no placeholder address, because a wrong `mn_dust` would silently send a
 * user's DUST generation into a hole nobody controls. Expo inlines only member expressions
 * on `process.env`, hence the literal read.
 */
const rawDonationAddress = dustDonationAddress()

/** Pnyx's DUST address, or `null` when this build has none configured. */
export const pnyxDustAddress = (): string | null => {
  const value = rawDonationAddress?.trim()
  return value === undefined || value === '' ? null : value
}

/** Where a registration's DUST is going, in terms the UI can label. */
export type DestinationOwner =
  /** This wallet's own DUST address. */
  | {readonly kind: 'self'}
  /** Another wallet in this app. */
  | {readonly kind: 'ownWallet'; readonly walletName: string}
  /** Pnyx — the donation destination. */
  | {readonly kind: 'pnyx'}
  /** A valid address we have no name for. Legitimate: delegation to someone else. */
  | {readonly kind: 'external'}
  /** The registration exists but its destination could not be read. */
  | {readonly kind: 'unknown'}

/** One address the user may choose, with the name to show for it. */
export type DestinationChoice = {
  /** Raw payload hex — what the datum carries and what comparisons use. */
  readonly payload: DustAddrPayload
  /** The bech32m `mn_dust…` form, for display and copying. */
  readonly address: string
  readonly owner: DestinationOwner
}

const eq = (a: string | undefined, b: string | undefined): boolean =>
  a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase()

/**
 * Name the owner of `payload` against the choices we know about.
 *
 * `undefined` payload means the datum was unreadable — distinct from an address we can read
 * but do not recognise, because the first is our blind spot and the second is the user's
 * deliberate choice.
 */
export const describeDestination = (
  payload: DustAddrPayload | undefined,
  choices: readonly DestinationChoice[],
): DestinationOwner => {
  if (payload === undefined) return {kind: 'unknown'}
  const match = choices.find((c) => eq(c.payload, payload))
  return match?.owner ?? {kind: 'external'}
}
