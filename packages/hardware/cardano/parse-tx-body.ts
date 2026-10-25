/**
 * Cardano transaction-body parsing for hardware signing.
 *
 * Decodes a CBOR transaction body into a typed view plus a `tagCborSets` flag (true when the
 * original used Conway #6.258 set tags — the device must re-emit tagged sets to reproduce the same
 * body hash). The Ledger / Trezor sign-request builders consume this view; device.ts stays
 * byte-faithful.
 *
 * One parser: the fork's review tier. The pre-fork parse it was held against lived in the retired
 * `cardano-effect` repo (branch `retired-final-2026-10-09`, `harness/_origin-parse-tx-body.mjs`);
 * it had no production caller here.
 *
 * @module
 */

import * as ForkInspect from '@evolution-sdk/review/Inspect'
import {Effect} from 'effect'
import {HardwareError} from '../types'

/** The typed transaction-body view the device sign-request builders consume. */
export type ParsedCardanoTxBody = ForkInspect.TxBodyView

const asHardwareError = (error: {readonly message: string}): HardwareError =>
  new HardwareError({message: `Failed to parse transaction body: ${error.message}`, cause: error})

export const parseTransactionBody = (
  txBodyHex: string,
): Effect.Effect<{body: ParsedCardanoTxBody; tagCborSets: boolean}, HardwareError> =>
  ForkInspect.txBody(txBodyHex).pipe(
    Effect.map(({body, taggedSets}) => ({body, tagCborSets: taggedSets})),
    Effect.mapError(asHardwareError),
  )
