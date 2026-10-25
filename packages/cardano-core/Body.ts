// Scalar/set body-field encoders (for plan `bodyExtra` entries) + the Conway
// body-map key numbers, so callers don't hard-code magic keys.

import {Bytes, CBOR} from '@evolution-sdk/evolution'
import type {KeyHashHex} from '@evolution-sdk/review/Brands'
import {op} from './Op.js'

/**
 * `required_signers` (body key 14) — a `#6.258` set of 28-byte key hashes.
 *
 * ⚠️ Always tagged. Conway accepts a bare array too and the two are different bytes, so a builder
 * that emits one shape and a reviewer that assumes the other disagree about what was signed.
 */
export const requiredSignersSync = (keyHashHexes: ReadonlyArray<KeyHashHex>): string =>
  Bytes.toHex(CBOR.encodeTaggedSet(keyHashHexes.map((h) => CBOR.toCBORBytes(Bytes.fromHex(h)))))

export const requiredSigners = (keyHashHexes: ReadonlyArray<KeyHashHex>) =>
  op('requiredSigners', () => requiredSignersSync(keyHashHexes))

/** Plutus language id: 0 = V1, 1 = V2, 2 = V3. Named by `CostModel` below. */
export enum Language {
  PlutusV1 = 0,
  PlutusV2 = 1,
  PlutusV3 = 2,
}

export interface CostModel {
  readonly language: Language
  readonly costs: ReadonlyArray<bigint>
}
