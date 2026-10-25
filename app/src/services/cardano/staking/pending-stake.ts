/**
 * Whether a shared wallet already has a staking change waiting for signatures.
 *
 * The stake screen reads the *chain*, and the chain does not change until a
 * gathered transaction is submitted. So between originating an unstake and its
 * last co-signer signing, the screen showed the old state and would happily
 * build a second transaction against it — two certificates for one decision,
 * the second of which the ledger rejects once the first lands.
 *
 * Detected from the body rather than from a label, using the same predicate
 * signing and the co-sign envelope use (`bodyNamesStakeScript`): a pending
 * *send* from the same wallet is not a staking change and must not block one.
 *
 * @module
 */

import * as Inspect from '@evolution-sdk/review/Inspect'
import {bodyNamesStakeScript} from '@pnyx/tx-review'
import {Effect} from 'effect'
import type {TxEnvelope} from '../cosign/types'

export type PendingStakeEntry = {
  readonly id: string
  readonly envelope: TxEnvelope
}

/**
 * The id of a pending envelope that acts on `stakeScriptHashHex`, or `null`.
 *
 * A body we cannot decode is skipped rather than treated as a match: refusing to
 * build on an unreadable record would strand the screen with no way forward, and
 * the honest reading of "cannot tell" is not "yes".
 */
export const findPendingStakeChange = (
  entries: readonly PendingStakeEntry[],
  stakeScriptHashHex: string,
): Effect.Effect<string | null> =>
  Effect.gen(function* () {
    for (const entry of entries) {
      const body = yield* Inspect.txBody(entry.envelope.bodyHex).pipe(
        Effect.map((r) => r.body),
        Effect.orElseSucceed(() => null),
      )
      if (body === null) continue
      if (bodyNamesStakeScript(body, stakeScriptHashHex)) return entry.id
    }
    return null
  })
