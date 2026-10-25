/**
 * Per-output min-ADA, the ledger's own rule rather than a guess.
 *
 * A Cardano output must carry at least `(160 + |serialized output|) *
 * coinsPerUtxoByte` lovelace, so the floor depends on what the output *contains*:
 * the address, and every policy id and asset name in it. Measured against mainnet
 * params (4310), one short-named token needs ~1.16 ADA, a 32-byte name ~1.27, and
 * twenty assets across four policies ~2.56 — so a single flat constant is either
 * wrong for the small case or punitive for it.
 *
 * ⚠️ **Pure, with nothing injected.** It used to take a three-operation `MinAdaCodec` because
 * sizing an output meant encoding a value and an output through the codec. The output is
 * Evolution's `TxOut` and the floor is its own `MinAda.forOutput`, so there is nothing to inject
 * and nothing to stub — which also means a test exercises the measurement the wallet performs
 * rather than a double of it.
 *
 * ⚠️ **One implementation, where there were two.** `agent-build.ts` carried the same fixed point
 * with attachment support, so the ordinary send and the agent build measured the floor through
 * separate copies that could drift — and the floor is the number that decides whether the ledger
 * accepts an output at all. The attachments moved here and that copy is gone.
 *
 * @module
 */

import {Address, Assets, InlineDatum, MinAda, ScriptRef, TxOut} from '@evolution-sdk/evolution'
import type {AddressHex} from '@evolution-sdk/review/Brands'

import {logger} from '../../../logger'

/** Lovelace key in a send basket. */
const ADA_ID = ''

/**
 * Iterations of the fixed point. Raising the coin can widen its own CBOR integer,
 * which grows the output and can raise the floor again; in practice this settles
 * in one or two steps, and the cap keeps a pathological input from spinning.
 */
const MAX_ROUNDS = 4

/** A coin to size the first round with — large enough to be CBOR-wide from the start. */
const PROBE_COIN = 5_000_000n

/**
 * The minimum lovelace this exact output may carry, or `null` when it cannot be measured (a
 * malformed address or asset id). `null` means "unknown", not "no floor" — callers must not treat
 * it as zero.
 */
export const minAdaForOutput = (
  coinsPerUtxoByte: bigint,
  addressHex: AddressHex,
  amounts: ReadonlyMap<string, bigint>,
  /**
   * ⚠️ **A datum and a reference script count toward the floor**, and a script is by far the
   * largest thing an output can carry — publishing an 8 KB validator needs tens of ADA, not the
   * two a bare output needs. Measuring without them underfunds the deployment by an order of
   * magnitude, so the agent build passes them and the ordinary send has none to pass.
   *
   * ⚠️ `InlineDatum.fromCBORHex`, which records the datum's arrival bytes: a datum re-derived
   * from its parsed tree can be a different LENGTH, and the length is what is being measured.
   */
  attachments: {readonly datumHex?: string; readonly scriptRefHex?: string} = {},
): bigint | null => {
  const assets = [...amounts].filter(([id]) => id !== ADA_ID)
  try {
    const address = Address.fromHex(addressHex)
    let coin = PROBE_COIN
    for (let round = 0; round < MAX_ROUNDS; round++) {
      // ⚠️ `encodingFormat: 'babbage'` is load-bearing and not a preference. Conway accepts both
      // the Shelley array and the Babbage map, Evolution defaults to Shelley, and they are
      // DIFFERENT BYTES — so a floor measured in one shape is the wrong floor for an output
      // emitted in the other. Every output this wallet emits is the Babbage map.
      const output = new TxOut.TransactionOutput({
        address,
        assets: Assets.fromRecord({lovelace: coin, ...Object.fromEntries(assets)}),
        encodingFormat: 'babbage',
        ...(attachments.datumHex === undefined ? {} : {datumOption: InlineDatum.fromCBORHex(attachments.datumHex)}),
        ...(attachments.scriptRefHex === undefined ? {} : {scriptRef: ScriptRef.fromHex(attachments.scriptRefHex)}),
      })
      const next = MinAda.forOutput(output, coinsPerUtxoByte)
      if (next === coin) return next
      coin = next
    }
    return coin
  } catch (e: unknown) {
    // ⚠️ `null` is "no minimum known", so the caller stops enforcing the floor and the output is
    // only refused once the node sees it.
    logger.warn('Minimum ADA for an output could not be computed; the floor is not enforced', {
      origin: 'send/min-ada',
      error: String(e),
    })
    return null
  }
}
