/**
 * The transaction that publishes a shared wallet's CIP-146 registration.
 *
 * A freshly created shared wallet holds nothing, so it cannot pay for its own
 * registration — which is why the wallet records the *intent* at creation and
 * settles it later. This is the settling: an ordinary transaction from a
 * co-signer's own funded wallet, carrying the label-1854 metadata and the two
 * compiled scripts in its auxiliary data.
 *
 * It goes out through the same send builder every other transaction uses, so it
 * inherits coin selection, the fee pass, the size check, the review IR and the
 * signing paths. A bespoke builder would be a second place for all of those to
 * be wrong.
 *
 * The output is the payer's own address: the transaction exists to carry
 * metadata, and paying anyone is not part of that. Sending to the shared wallet
 * instead would look like funding it, which is a separate decision the user has
 * not made here.
 *
 * @module
 */

import type {CborError} from '@evolution-sdk/review/Errors'
import type {CoreError} from '@pnyx/cardano-core/Op'
import {Effect} from 'effect'
import {ADA_ID} from '../../../screens/cardano/send/state'
import type {CardanoRail} from '../rail'
import {buildEnhancedSendReview, type SendBuildError, type SendReview} from '../send-flow'
import {scriptsAt} from './derive'
import {registrationAuxData, registrationFor, registrationScripts} from './registration'
import type {SharedWallet} from './types'

/**
 * The smallest output the payer can send themselves.
 *
 * Not a guess: the builder raises an under-minimum output to the ledger's own
 * floor and the review shows what it settled on, so this only has to be low
 * enough not to move more than necessary.
 */
const CARRIER_LOVELACE = 1_000_000n

/**
 * Build the registration transaction, paid by `rail`'s wallet.
 *
 * `rail` is the **payer's** rail, never the shared wallet's — a shared wallet
 * that could pay for this would not need someone else to.
 */
export const buildRegistrationReview = (params: {
  readonly rail: CardanoRail
  readonly groupId: string
  readonly wallet: SharedWallet
  /** Payment index whose scripts are registered. Index 0 is the wallet's first address. */
  readonly keyIndex?: number
}): Effect.Effect<SendReview, SendBuildError | CborError | CoreError> =>
  Effect.gen(function* () {
    const scripts = yield* scriptsAt(params.wallet, params.keyIndex ?? 0)
    const auxiliaryDataHex = yield* registrationAuxData(registrationFor(params.wallet), registrationScripts(scripts))
    return yield* buildEnhancedSendReview(params.rail, params.groupId, {
      targets: [
        {
          addressHex: params.rail.account.addressHex,
          // `ADA_ID`, not the balance layer's `'.'`: the send layer keys ADA on
          // the empty string, and anything else is read as a `policy.name` token
          // id — which fails as "expected 28-byte policy id, got 0".
          amounts: new Map([[ADA_ID, CARRIER_LOVELACE]]),
        },
      ],
      auxiliaryDataHex,
    })
  })
