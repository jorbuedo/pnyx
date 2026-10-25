/**
 * Turn a SteelSwap-built (externally-assembled) swap tx into the parts the
 * shared signing rail re-assembles under our control. SteelSwap returns a fully
 * formed, unsigned tx carrying the DEX's script witnesses (redeemers, plutus
 * scripts, datums) and — for Plutus routes — collateral already selected in the
 * body. We do NOT re-plan it (unlike the Midnight-redeem rebuild): the body is
 * kept byte-exact so the script-data hash stays valid, and only our vkey witness
 * is added at assembly (`signOnly: false`).
 *
 * The split is the seam: body (element 0) drives the review + signing paths;
 * `witnessExtra` (every non-vkey witness-set entry) and `auxHex` are re-attached
 * verbatim by `Tx.assemble` so ex-units, script hashes and datum bytes survive.
 *
 * @module
 */

import type {CborError} from '@evolution-sdk/review/Errors'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Effect} from 'effect'

export type SplitSwapTx = {
  readonly bodyHex: string
  /** Non-vkey witness-set entries (scripts / datums / redeemers), `[key, cborHex]`. */
  readonly witnessExtra: readonly (readonly [number, string])[]
  /**
   * Vkey witnesses SteelSwap already attached (witness-set key 0).
   *
   * ⚠️ These must be carried into assembly, not dropped. `witnessSetEntries`
   * deliberately excludes key 0 — we normally produce the whole vkey set
   * ourselves, so a stale one would be a duplicate map key. But a build that
   * answers `partialSign: true` says *"the transaction already carries a
   * SteelSwap witness — ADD yours instead of replacing the set"*, and dropping
   * it submits a transaction one required signature short.
   */
  readonly foreignVkeyWitnesses: readonly Inspect.VkeyWitnessView[]
  /** Auxiliary data CBOR, or `''` when the tx has none. */
  readonly auxHex: string
}

/** Split a built swap tx (CBOR hex) into the parts assembly re-attaches. */
export const splitBuiltSwapTx = (txCbor: string): Effect.Effect<SplitSwapTx, CborError> =>
  Effect.gen(function* () {
    const bodyHex = yield* Inspect.txBodyFromTx(txCbor)
    const witnessSetHex = yield* Inspect.witnessSetFromTx(txCbor)
    const witnessExtra = yield* Inspect.witnessSetEntries(witnessSetHex)
    const foreignVkeyWitnesses = yield* Inspect.witnessSetVkeys(witnessSetHex)
    const auxHex = yield* Inspect.auxFromTx(txCbor)
    return {bodyHex, witnessExtra, foreignVkeyWitnesses, auxHex}
  })
