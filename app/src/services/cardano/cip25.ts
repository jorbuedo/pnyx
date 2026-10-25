/**
 * CIP-25 token metadata: the `721` label a minting transaction carries so wallets and explorers can
 * name and picture the asset.
 *
 * ⚠️ **Without it a minted NFT is an unnamed token everywhere.** Nothing on chain records an asset's
 * name or image except this map, and it can only be attached in the transaction that mints — so a mint
 * that skipped it cannot be corrected later under the same policy unless that policy can still mint.
 *
 * ⚠️ **Version 1, which keys the asset by its name as text.** That is the version wallets and explorers
 * read most reliably; version 2 keys by the raw bytes. It is why an asset whose name is not valid UTF-8
 * gets no metadata rather than a wrong key — an asset id that does not match is worse than an absent
 * one, because it renders as another token's picture.
 *
 * @module
 */

import {Meta} from '@pnyx/cardano-core'
import type {CoreError} from '@pnyx/cardano-core/Op'
import {Effect} from 'effect'

/** The registered CIP-25 metadata label. */
export const CIP25_LABEL = 721n

/**
 * A metadata string may not exceed 64 **bytes** on chain, and a longer one is written as a list of
 * chunks — which is how every IPFS URI longer than that is carried.
 */
export const chunk64 = (text: string): readonly string[] => {
  const encoder = new TextEncoder()
  const chunks: string[] = []
  let current = ''
  let bytes = 0
  for (const ch of text) {
    const size = encoder.encode(ch).length
    if (bytes + size > 64) {
      chunks.push(current)
      current = ch
      bytes = size
    } else {
      current += ch
      bytes += size
    }
  }
  if (current.length > 0 || chunks.length === 0) chunks.push(current)
  return chunks
}

/**
 * Encode a JSON value as a transaction metadatum.
 *
 * ⚠️ **A number must be a whole number.** Transaction metadata has no floating-point type at all, so a
 * fraction would have to be rounded or stringified — both of which quietly change what the caller
 * wrote. It is refused instead.
 */
export const metadatumOf = (value: unknown, path: string): Effect.Effect<string, CoreError | Error> =>
  Effect.gen(function* () {
    if (typeof value === 'string') {
      const chunks = chunk64(value)
      if (chunks.length === 1) return yield* Meta.text(chunks[0] as string)
      return yield* Meta.list(yield* Effect.forEach(chunks, (c) => Meta.text(c)))
    }
    if (typeof value === 'boolean') return yield* Meta.text(value ? 'true' : 'false')
    if (typeof value === 'number') {
      if (!Number.isInteger(value)) {
        return yield* Effect.fail(new Error(`${path} must be a whole number — transaction metadata has no fractions`))
      }
      return yield* Meta.int(BigInt(value))
    }
    if (Array.isArray(value)) {
      return yield* Meta.list(yield* Effect.forEach(value, (item, i) => metadatumOf(item, `${path}[${i}]`)))
    }
    if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value as Record<string, unknown>)
      const keys = yield* Effect.forEach(entries, ([k]) => Meta.text(k))
      const values = yield* Effect.forEach(entries, ([k, v]) => metadatumOf(v, `${path}.${k}`))
      return yield* Meta.map(keys, values)
    }
    return yield* Effect.fail(
      new Error(`${path} is ${value === null ? 'null' : typeof value}, which cannot be metadata`),
    )
  })

/**
 * Auxiliary data carrying one asset's CIP-25 entry: `721 → {policyId → {assetName → fields}}`.
 *
 * `assetName` is the name as text, not hex — see the module note on version 1.
 */
export const cip25AuxiliaryData = (params: {
  readonly policyId: string
  readonly assetName: string
  readonly fields: Record<string, unknown>
}): Effect.Effect<string, CoreError | Error> =>
  Effect.gen(function* () {
    const fields = yield* metadatumOf(params.fields, 'metadata')
    const byAsset = yield* Meta.map([yield* Meta.text(params.assetName)], [fields])
    const byPolicy = yield* Meta.map([yield* Meta.text(params.policyId)], [byAsset])
    return yield* Meta.auxiliaryData(yield* Meta.metadata([CIP25_LABEL], [byPolicy]))
  })
