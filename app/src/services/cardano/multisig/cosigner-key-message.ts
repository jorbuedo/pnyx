/**
 * The message for each way a co-signer key can fail to arrive.
 *
 * A `Record` over the failure kind rather than a conditional chain in each
 * screen: four screens ask for this key, and when the mapping lived in each of
 * them they disagreed — one reported every failure as "Enter a valid co-signer
 * key", which is a message about a text field for a failure in the keychain.
 * Total, so a new failure kind is a type error here rather than a silent
 * fallthrough to whichever branch happened to be last.
 *
 * @module
 */

import type {TranslationKey} from '../../../i18n/types'
// Type-only, so this stays a pure module and adds no runtime edge back to
// `group-seed` (which imports this directory's barrel for the eligibility rules).
import type {CoSignerXpubFailure} from '../../group-seed'
import {reasonKeyOf} from './eligibility'

const KIND_KEY: Readonly<Record<Exclude<CoSignerXpubFailure['kind'], 'ineligible'>, TranslationKey>> = {
  'no-key-material': 'multisig.create.errorNoKeyMaterial',
  'auth-cancelled': 'multisig.create.errorAuthCancelled',
  'key-invalidated': 'multisig.create.errorKeyInvalidated',
  'vault-error': 'multisig.create.errorBuild',
  'derivation-failed': 'multisig.create.errorBuild',
  'device-key-missing': 'multisig.create.deviceKeyMissing',
}

export const coSignerFailureKey = (failure: CoSignerXpubFailure): TranslationKey =>
  failure.kind === 'ineligible' ? reasonKeyOf(failure.reason) : KIND_KEY[failure.kind]

/**
 * Whether this failure is one the user can clear by connecting their device.
 *
 * Drives an actionable message rather than a dead one — the difference between
 * "Hardware wallets cannot be added as co-signers yet", which reads as a missing
 * feature, and a button that imports the key.
 */
export const failureNeedsDevice = (failure: CoSignerXpubFailure): boolean => failure.kind === 'device-key-missing'
