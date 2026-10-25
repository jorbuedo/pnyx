// Transaction metadata + Conway auxiliary_data facade. Compose metadatum nodes
// (int/bytes/text/list/map), collect into `metadata` (label → metadatum), wrap as
// `auxiliaryData`. Byte-exact vs CSL. The plan sets aux_data_hash automatically
// when given `auxiliaryDataHex`.

import {AuxiliaryData, Bytes, Metadata, TransactionMetadatum} from '@evolution-sdk/evolution'
import {op} from './Op.js'

const node = (hex: string) => TransactionMetadatum.fromCBORHex(hex)
const paired = (
  keyHexes: ReadonlyArray<string>,
  valHexes: ReadonlyArray<string>,
  what: string,
): Array<[TransactionMetadatum.TransactionMetadatum, TransactionMetadatum.TransactionMetadatum]> =>
  keyHexes.map((k, i) => {
    const v = valHexes[i]
    if (v === undefined) throw new Error(`${what}: key ${i} has no value`)
    return [node(k), node(v)]
  })

// --- metadatum nodes (compose via hex) ---
export const int = (value: bigint) =>
  op('metadatumInt', () => TransactionMetadatum.toCBORHex(TransactionMetadatum.int(value)))
export const text = (s: string) =>
  op('metadatumText', () => TransactionMetadatum.toCBORHex(TransactionMetadatum.text(s)))
export const list = (itemHexes: ReadonlyArray<string>) =>
  op('metadatumList', () => TransactionMetadatum.toCBORHex(TransactionMetadatum.array(itemHexes.map(node))))
export const map = (keyHexes: ReadonlyArray<string>, valHexes: ReadonlyArray<string>) =>
  op('metadatumMap', () =>
    TransactionMetadatum.toCBORHex(TransactionMetadatum.fromEntries(paired(keyHexes, valHexes, 'metadatum map'))),
  )

/**
 * metadata map `{ label => metadatum }` (labels sorted ascending).
 *
 * ⚠️ `Metadata`'s codec helpers are CURRIED on options — `toCBORHex(opts)(data)` — while every
 * neighbouring module's are `toCBORHex(data, opts)`. Called the usual way it returns the encoder
 * instead of the bytes, silently.
 */
export const metadata = (labels: ReadonlyArray<bigint>, metadatumHexes: ReadonlyArray<string>) =>
  op('metadata', () =>
    Metadata.toCBORHex()(
      Metadata.fromEntries(
        labels.map((label, i): [bigint, TransactionMetadatum.TransactionMetadatum] => {
          const md = metadatumHexes[i]
          if (md === undefined) throw new Error(`metadata: label ${label} has no metadatum`)
          return [label, node(md)]
        }),
      ),
    ),
  )

/**
 * `auxiliary_data` from metadata (+ optional native scripts).
 *
 * ⚠️ The era form is part of `auxiliary_data_hash` and therefore of the transaction id: bare
 * metadata stays Shelley, anything carrying scripts becomes Conway (`#6.259`). Always writing
 * Conway would change the id of every metadata-only transaction, which is most of them.
 */
export const auxiliaryData = (metadataHex: string, nativeScriptHexes: ReadonlyArray<string> = []) =>
  op('auxiliaryData', () =>
    AuxiliaryData.toCBORHex(
      AuxiliaryData.fromEncoded({
        ...(metadataHex === '' ? {} : {metadata: Bytes.fromHex(metadataHex)}),
        nativeScripts: nativeScriptHexes.map((h) => Bytes.fromHex(h)),
      }),
    ),
  )
