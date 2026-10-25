/**
 * What has to happen locally once a gathered envelope is broadcast.
 *
 * `submitEnvelope` hands the transaction to the node and stops there, which
 * leaves the wallet believing the inputs it just spent are still available: the
 * next send would select them again and be rejected as a double spend, with no
 * explanation the user could act on. Every other broadcast path in the app
 * registers its pending transaction; this is the piece that lets the co-sign
 * rail do the same.
 *
 * @module
 */

import type {Decode} from '@evolution-sdk/review/Decode'
import type {CborError} from '@evolution-sdk/review/Errors'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Effect} from 'effect'

/**
 * The UTxO ids a transaction body consumes, in the `txHash:index` form the
 * pending tracker keys on.
 *
 * Read off the body rather than remembered from the build, because the co-signer
 * who submits is usually not the one who built: all they hold is the envelope.
 */
export const consumedUtxoIdsOf = (bodyHex: string): Effect.Effect<readonly string[], CborError, Decode> =>
  Inspect.txBody(bodyHex).pipe(
    Effect.map(({body}) => (body.inputs ?? []).map((input) => `${input.txHashHex.toLowerCase()}:${input.index}`)),
  )
