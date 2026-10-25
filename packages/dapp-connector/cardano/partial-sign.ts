/**
 * CIP-30 `partialSign` enforcement: when a dApp asks for a full sign
 * (`partialSign: false`), the wallet must be able to produce EVERY witness the
 * tx requires. This checks a produced witness set against the required key
 * hashes (resolved by the app via `@pnyx/tx-review`'s signing-path engine).
 *
 * @module
 */

import type {CborError} from '@evolution-sdk/review/Errors'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Keys} from '@pnyx/cardano-core'
import {Effect} from 'effect'

/**
 * Key hashes in `requiredKeyHashes` with no matching vkey witness in
 * `witnessSetHex`. Empty = full coverage. Comparison is case-insensitive hex.
 */
export const verifyWitnessCoverage = (
  witnessSetHex: string,
  requiredKeyHashes: readonly string[],
): Effect.Effect<readonly string[], CborError> =>
  requiredKeyHashes.length === 0
    ? Effect.succeed([])
    : Effect.gen(function* () {
        const witnesses = yield* Inspect.witnessSetVkeys(witnessSetHex)
        const covered = new Set(witnesses.map((w) => Keys.keyHashSync(w.vkeyHex).toLowerCase()))
        return requiredKeyHashes.filter((required) => !covered.has(required.toLowerCase()))
      })
