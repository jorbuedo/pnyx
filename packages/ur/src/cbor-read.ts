/**
 * Two conveniences for the registry's map-shaped items, over `@evolution-sdk/evolution`'s
 * `CBORBuilder.Deserializer`.
 *
 * ⚠️ **Not a second CBOR implementation** — every byte is read by that codec, including the
 * boolean values and the unknown-key skips these two rely on (`Deserializer.bool()` and
 * `.skipValue()`, which started life here and moved upstream where they belong).
 *
 * @module
 */

import * as Cbor from '@evolution-sdk/evolution/CBORBuilder'

export type CborReader = InstanceType<typeof Cbor.Deserializer>

export const cborReader = (bytes: Uint8Array): CborReader => Cbor.Deserializer.from(bytes)

/**
 * Walk a definite-length map, dispatching each integer key to `onEntry`. Unknown keys — those the
 * handler leaves unconsumed by returning false — are skipped, so a field a newer device adds does
 * not cost us a request we could otherwise honour.
 */
export const readMapEntries = (cursor: CborReader, onEntry: (key: number) => boolean): void => {
  const length = cursor.map()
  if (typeof length === 'string') throw new Error('cbor: expected a definite-length map')
  for (let i = 0; i < length.definite; i++) {
    const key = Number(cursor.unsignedInteger())
    if (!onEntry(key)) cursor.skipValue()
  }
}

/** Read a tagged value's tag, asserting it is the one expected. */
export const expectTag = (cursor: CborReader, expected: number, what: string): void => {
  const tag = Number(cursor.tag())
  if (tag !== expected) throw new Error(`cbor: expected ${what} (tag ${expected}), got tag ${tag}`)
}
