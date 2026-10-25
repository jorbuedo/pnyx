// PlutusData construction (datums / redeemer data), byte-exact vs CSL. Compose
// recursively: each builder returns the CBOR hex of that node; parents take
// children's hex. `Data.int/bytes/list/map/constr`.

import {Bytes, Data as EvData} from '@evolution-sdk/evolution'
import {PlutusDataHex} from '@evolution-sdk/review/Brands'
import {op} from './Op.js'

const items = (hexes: ReadonlyArray<string>) => hexes.map((h) => Bytes.fromHex(h))

/**
 * ⚠️ Both of these SPLICE their children rather than decoding them.
 *
 * A datum nested inside another datum is going back on the wire unchanged, and the one arrival
 * detail a decoded value cannot carry is the header width of an integer that IS the whole child
 * (`bigint` is not an object, so it has nowhere to keep the record). Evolution's `spliceList` /
 * `spliceConstr` / `spliceMap` are the byte-level path for exactly that.
 */
export const map = (keyHexes: ReadonlyArray<PlutusDataHex>, valHexes: ReadonlyArray<PlutusDataHex>) =>
  op('plutusDataMap', () =>
    PlutusDataHex(
      Bytes.toHex(
        EvData.spliceMap(
          keyHexes.map((k, i) => {
            const v = valHexes[i]
            if (v === undefined) throw new Error(`plutus_data map: key ${i} has no value`)
            return [Bytes.fromHex(k), Bytes.fromHex(v)] as const
          }),
        ),
      ),
    ),
  )
/** Constructor `alt(fields)` — compact tag for alt ≤ 127, else general tag 102. */
export const constr = (alt: bigint, fieldHexes: ReadonlyArray<PlutusDataHex>) =>
  op('plutusDataConstr', () => PlutusDataHex(Bytes.toHex(EvData.spliceConstr(alt, items(fieldHexes)))))
