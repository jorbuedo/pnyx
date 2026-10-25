/**
 * CIP-146 shared-wallet registration: the label-1854 metadata that publishes a
 * wallet on-chain so participants can find it and label each other.
 *
 * The registration is what makes a shared wallet recoverable from the chain
 * rather than only from whoever's phone still holds it. It carries the native
 * scripts in the transaction's auxiliary data, a `types` array running parallel
 * to them saying what each script is for, and the participants' display names.
 *
 * **On discovery.** CIP-146 describes a chain-wide scan: derive your own
 * `1854'/1815'/0'/x/y` credentials and search for label-1854 registrations that
 * reference them, oldest match winning — which is the anti-phishing rule, so it
 * needs a *total* view of registrations for a credential, not a partial one.
 *
 * This module used to say that query was not available. It was, and the claim
 * was about the wrong thing: `Provider` had no way to search by metadata, and
 * that gap in our own port was written down as a fact about the backend. Koios
 * exposes `tx_by_metalabel`, and the whole global set for label 1854 is small
 * enough to fetch outright. The enumeration lives in `registration-discovery.ts`;
 * this module stays what it always was — writing a registration, and reading one
 * back from a transaction.
 *
 * @module
 */

import {Meta} from '@pnyx/cardano-core'
import type {CoreError} from '@pnyx/cardano-core/Op'
import {Effect} from 'effect'
import type {CoSignerRef, SharedWallet} from './types'

/** The CIP-146 metadata label. Same number as the derivation purpose. */
export const CIP146_LABEL = 1854n

/**
 * What a registered native script is for. The array of these runs parallel to
 * the transaction's `native_scripts`, so position is meaning: "the ScriptType
 * mapping array in metadata must match the length of, and directly corresponds
 * to the elements in the native_script array".
 */
export const SCRIPT_TYPE = {
  payment: 0,
  delegation: 1,
} as const

export type ScriptType = (typeof SCRIPT_TYPE)[keyof typeof SCRIPT_TYPE]

export type RegistrationParticipant = {
  readonly name: string
  readonly description?: string
}

export type MultisigRegistration = {
  /** Parallel to the aux-data native scripts, in the same order. */
  readonly types: readonly ScriptType[]
  readonly name?: string
  readonly description?: string
  /** Keyed by co-signer tag, so a reader can label each leaf of the script. */
  readonly participants?: Readonly<Record<string, RegistrationParticipant>>
}

/**
 * The registration record for a wallet.
 *
 * Scripts are emitted payment-then-delegation and `types` says so, rather than
 * relying on a reader to guess from structure — the two templates are often
 * structurally identical, so structure cannot distinguish them.
 */
export const registrationFor = (wallet: SharedWallet): MultisigRegistration => ({
  types: [SCRIPT_TYPE.payment, SCRIPT_TYPE.delegation],
  name: wallet.name,
  participants: Object.fromEntries(
    wallet.coSigners.map((c): [string, RegistrationParticipant] => [c.tag, {name: c.name}]),
  ),
})

/** The two scripts a registration covers, in the order `types` declares. */
export const registrationScripts = (scripts: {
  readonly paymentScriptHex: string
  readonly stakingScriptHex: string
}): readonly string[] => [scripts.paymentScriptHex, scripts.stakingScriptHex]

/**
 * Encode the registration as a CBOR metadatum.
 *
 * Keys are text, matching the CIP's interface field names, and absent optional
 * fields are omitted rather than emitted empty — a reader cannot tell an empty
 * string from "the creator chose not to say".
 */
export const encodeRegistration = (registration: MultisigRegistration): Effect.Effect<string, CoreError> =>
  Effect.gen(function* () {
    const keys: string[] = []
    const values: string[] = []

    keys.push(yield* Meta.text('types'))
    values.push(yield* Meta.list(yield* Effect.forEach(registration.types, (v) => Meta.int(BigInt(v)))))

    if (registration.name !== undefined) {
      keys.push(yield* Meta.text('name'))
      values.push(yield* Meta.text(registration.name))
    }
    if (registration.description !== undefined) {
      keys.push(yield* Meta.text('description'))
      values.push(yield* Meta.text(registration.description))
    }
    if (registration.participants !== undefined) {
      const entries = Object.entries(registration.participants)
      const pKeys = yield* Effect.forEach(entries, ([tag]) => Meta.text(tag))
      const pValues = yield* Effect.forEach(entries, ([, participant]) =>
        Effect.gen(function* () {
          const innerKeys = [yield* Meta.text('name')]
          const innerValues = [yield* Meta.text(participant.name)]
          if (participant.description !== undefined) {
            innerKeys.push(yield* Meta.text('description'))
            innerValues.push(yield* Meta.text(participant.description))
          }
          return yield* Meta.map(innerKeys, innerValues)
        }),
      )
      keys.push(yield* Meta.text('participants'))
      values.push(yield* Meta.map(pKeys, pValues))
    }
    return yield* Meta.map(keys, values)
  })

/**
 * The auxiliary data for a registration transaction: the label-1854 metadata
 * plus the native scripts it describes.
 *
 * The scripts ride in aux data, not in the metadatum, because that is where
 * CIP-146 says a reader will find them — and it is the same place the ledger
 * already carries a transaction's native scripts.
 */
export const registrationAuxData = (
  registration: MultisigRegistration,
  scriptHexes: readonly string[],
): Effect.Effect<string, CoreError> =>
  Effect.gen(function* () {
    if (scriptHexes.length !== registration.types.length) {
      // Positional correspondence is the whole contract; a mismatch would label
      // the delegation script as payment.
      return yield* Effect.die(
        new Error(`registrationAuxData: ${registration.types.length} types for ${scriptHexes.length} scripts`),
      )
    }
    const metadatum = yield* encodeRegistration(registration)
    const metadata = yield* Meta.metadata([CIP146_LABEL], [metadatum])
    return yield* Meta.auxiliaryData(metadata, scriptHexes)
  })

/**
 * A registration decoded from chain, paired with the wallet fields it can
 * restore. Kept separate from {@link SharedWallet} because a registration alone
 * cannot rebuild one: it carries the compiled scripts and the participants'
 * names, but not their account xpubs, so addresses beyond the registered ones
 * cannot be derived from it.
 */
export type DecodedRegistration = {
  readonly registration: MultisigRegistration
  readonly scriptHexes: readonly string[]
}

/** Which script in a decoded registration serves which role, by its `types` entry. */
export const scriptOfType = (decoded: DecodedRegistration, type: ScriptType): string | null => {
  const at = decoded.registration.types.indexOf(type)
  return at === -1 ? null : (decoded.scriptHexes[at] ?? null)
}

/**
 * Participant names from a registration, in template-tag order.
 *
 * Used to label a roster the user is joining, so the names shown come from the
 * registration rather than being invented locally.
 */
export const participantNames = (
  decoded: DecodedRegistration,
  tags: readonly string[],
): readonly Pick<CoSignerRef, 'tag' | 'name'>[] =>
  // Falls back to the tag, which is what the script actually references — a
  // truthful label rather than an invented "Unknown".
  tags.map((tag) => ({tag, name: decoded.registration.participants?.[tag]?.name ?? tag}))
