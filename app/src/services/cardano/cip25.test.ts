// The metadata is the only place an asset's name and image exist on chain, and it can only be attached
// in the transaction that mints — so what these pin is what a mint would carry for ever.

import * as Inspect from '@evolution-sdk/review/Inspect'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {chunk64, cip25AuxiliaryData, metadatumOf} from './cip25'

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)

describe('chunk64', () => {
  it('leaves a short string whole', () => {
    expect(chunk64('ipfs://short')).toEqual(['ipfs://short'])
  })

  // ⚠️ Bytes, not characters. A 40-character string of emoji is 160 bytes and would be rejected on
  // chain if it were counted as 40.
  it('splits on bytes rather than characters', () => {
    const chunks = chunk64('🎨'.repeat(20))
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(new TextEncoder().encode(c).length).toBeLessThanOrEqual(64)
    expect(chunks.join('')).toBe('🎨'.repeat(20))
  })

  it('never splits a character in half', () => {
    // 16 four-byte characters is exactly 64 bytes; the seventeenth must start a new chunk.
    expect(chunk64('🎨'.repeat(17))).toEqual(['🎨'.repeat(16), '🎨'])
  })

  it('keeps an empty string as one empty chunk rather than nothing', () => {
    expect(chunk64('')).toEqual([''])
  })
})

describe('metadatumOf', () => {
  // ⚠️ Transaction metadata has no floating-point type. Rounding or stringifying would quietly change
  // what the caller wrote, so it is refused.
  it('refuses a fraction and names where it was', async () => {
    const out = await run(Effect.either(metadatumOf({price: 1.5}, 'metadata')))
    expect(out._tag).toBe('Left')
    // The path, not just "invalid": an agent with a twenty-field object needs to know which one.
    expect(out._tag === 'Left' && String(out.left.message)).toContain('metadata.price')
  })

  it('refuses null, which has no metadatum at all', async () => {
    const out = await run(Effect.either(metadatumOf({a: null}, 'metadata')))
    expect(out._tag).toBe('Left')
    expect(out._tag === 'Left' && String(out.left.message)).toContain('metadata.a')
  })

  it('encodes nested maps, lists and whole numbers', async () => {
    const hex = await run(metadatumOf({name: 'Pnyx', traits: ['blue', 'rare'], edition: 3}, 'metadata'))
    expect(hex.length).toBeGreaterThan(0)
  })
})

describe('cip25AuxiliaryData', () => {
  it('produces auxiliary data that decodes back to the 721 map it was given', async () => {
    const {aux, decoded} = await run(
      Effect.gen(function* () {
        const aux = yield* cip25AuxiliaryData({
          policyId: 'ab'.repeat(28),
          assetName: 'PnyxPass',
          fields: {name: 'Pnyx Pass', image: 'ipfs://QmSomething', description: 'a seat'},
        })
        return {aux, decoded: yield* Inspect.metadata(aux)}
      }),
    )
    expect(aux).not.toBe('')
    // The label the whole convention hangs on: a mint under any other label is invisible to wallets.
    expect(JSON.stringify(decoded)).toContain('721')
    expect(JSON.stringify(decoded)).toContain('Pnyx Pass')
    expect(JSON.stringify(decoded)).toContain('ab'.repeat(28))
  })
})
