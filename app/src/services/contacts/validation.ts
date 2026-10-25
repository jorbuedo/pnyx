/**
 * Contact address validation. Cardano addresses are decoded (bech32 → raw hex)
 * and inspected via the pure codec — a Byron address or an unparseable string
 * is rejected; network binding is deliberately NOT enforced (a contact may hold
 * an address for any network; the send flow binds the network at send time).
 *
 * Midnight addresses are decoded too, by the same parser the send funnel uses. A DUST address is
 * refused: it receives generated DUST and can never be paid, so it cannot be a payee. Chains whose
 * rails have not landed still get a non-empty check only — that is a known gap, not a claim.
 *
 * @module
 */

import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {type ChainId, getChainNamespace} from '@pnyx/config'
import {parseMidnightAddress} from '@pnyx/wallet'
import {Effect} from 'effect'

export type ContactValidation = {readonly ok: true} | {readonly ok: false; readonly reason: 'empty' | 'invalid-address'}

/**
 * A Cardano payee, decoded under the pure codec layer. A Byron address is refused; network binding is
 * deliberately not enforced, because the send flow binds the network at send time.
 *
 * Exported so the contact **card** can use the same check rather than growing a second copy of it — the
 * two surfaces ask the same question about the same string.
 */
export const validateCardanoAddress = (addressBech32: string): Effect.Effect<ContactValidation> =>
  // ⚠️ `Effect.try`, not an argument and not `suspend`. The input is whatever a user typed, and
  // this function promises a `{ok: false}` rather than a failure: built in the argument position
  // a refusal would throw before the pipeline exists, and inside `suspend` it would become a
  // defect, which `catchAll` does not catch. `try` puts it in the error channel where the
  // `catchAll` below can turn it into the answer.
  Effect.try(() => Bech32(addressBech32)).pipe(
    Effect.flatMap((bech32) => Address.fromBech32(bech32)),
    Effect.map((hex): ContactValidation => {
      const info = Address.inspect(hex)
      return info.kind === Address.AddressKind.Byron ? {ok: false, reason: 'invalid-address'} : {ok: true}
    }),
    Effect.catchAll((): Effect.Effect<ContactValidation> => Effect.succeed({ok: false, reason: 'invalid-address'})),
  )

/**
 * A Midnight payee: a night or shielded address, decoded rather than pattern-matched.
 *
 * A DUST address is rejected on purpose — it is well formed and simply cannot receive a payment.
 */
const validateMidnight = (addressBech32: string): ContactValidation => {
  const parsed = parseMidnightAddress(addressBech32)
  if (!parsed.ok) return {ok: false, reason: 'invalid-address'}
  return parsed.kind === 'night' || parsed.kind === 'shielded' ? {ok: true} : {ok: false, reason: 'invalid-address'}
}

/**
 * Validate a contact's address for its chain. Returns an Effect (Cardano
 * decoding runs under the pure codec layer); other chains resolve synchronously
 * via `Effect.succeed`.
 */
export const validateContactAddress = (chain: ChainId, addressBech32: string): Effect.Effect<ContactValidation> => {
  const trimmed = addressBech32.trim()
  if (trimmed.length === 0) return Effect.succeed({ok: false, reason: 'empty'})
  const namespace = getChainNamespace(chain)
  if (namespace === 'cardano') return validateCardanoAddress(trimmed)
  if (namespace === 'midnight') return Effect.succeed(validateMidnight(trimmed))
  return Effect.succeed({ok: true})
}

/** Non-empty name gate (whitespace-only rejected). Names are stored verbatim. */
export const isValidContactName = (name: string): boolean => name.trim().length > 0
