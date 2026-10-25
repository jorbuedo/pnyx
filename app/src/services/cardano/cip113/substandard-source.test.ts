import {Query as Cip113Query} from '@evolution-sdk/cip113'
import {Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import {Effect, Layer} from 'effect'
import {describe, expect, it} from 'vitest'
import {DEFAULT_SUBSTANDARD_EXUNITS, fetchSubstandards, UNIT_REDEEMER_HEX} from './substandard-source'

const REAL_BYTES = `588f${'01'.repeat(143)}`
const REAL_HASH = Cip113Query.scriptHashV3(REAL_BYTES)
const OTHER_BYTES = `588f${'02'.repeat(143)}`

/** A provider that serves exactly what the test says, and nothing else. */
const withProvider = (
  scriptByHash?: (h: string) => Effect.Effect<{bytesHex: string; version: 'V3'} | undefined, never>,
) =>
  Layer.succeed(EvolutionProvider.ProviderEffect, {
    // ⚠️ ABSENT, not throwing, when the backend cannot serve scripts: the subject reads presence
    // to decide whether a transfer is possible at all.
    ...(scriptByHash === undefined ? {} : {getScriptByHash: scriptByHash}),
  } as unknown as EvolutionProvider.ProviderEffect)

const run = (hashes: readonly string[], layer: Layer.Layer<EvolutionProvider.ProviderEffect>, opts = {}) =>
  Effect.runPromise(fetchSubstandards(hashes, opts).pipe(Effect.provide(layer)))

describe('fetchSubstandards', () => {
  it('returns a verified substandard with the unit redeemer', async () => {
    const r = await run(
      [REAL_HASH],
      withProvider(() => Effect.succeed({bytesHex: REAL_BYTES, version: 'V3' as const})),
    )
    expect(r.kind).toBe('ok')
    if (r.kind !== 'ok') return
    expect(r.substandards.get(REAL_HASH)).toEqual({
      scriptHashHex: REAL_HASH,
      scriptHex: REAL_BYTES,
      redeemerDataHex: UNIT_REDEEMER_HEX,
      exUnits: DEFAULT_SUBSTANDARD_EXUNITS,
    })
  })

  it('rejects bytes that do not hash to the registry-declared hash', async () => {
    // ⚠️ The check that makes fetching safe. The hash comes from the on-chain registry node, so
    // bytes that disagree are not the script the token names.
    const r = await run(
      [REAL_HASH],
      withProvider(() => Effect.succeed({bytesHex: OTHER_BYTES, version: 'V3' as const})),
    )
    expect(r).toEqual({kind: 'missing', scriptHashes: [REAL_HASH]})
  })

  it('reports a script the indexer does not have', async () => {
    const r = await run(
      [REAL_HASH],
      withProvider(() => Effect.succeed(undefined)),
    )
    expect(r).toEqual({kind: 'missing', scriptHashes: [REAL_HASH]})
  })

  it('treats a provider that cannot serve scripts as missing, not as empty-and-fine', async () => {
    const r = await run([REAL_HASH], withProvider(undefined))
    expect(r).toEqual({kind: 'missing', scriptHashes: [REAL_HASH]})
  })

  it('lets a caller supply a redeemer for a script that needs one', async () => {
    const r = await run(
      [REAL_HASH],
      withProvider(() => Effect.succeed({bytesHex: REAL_BYTES, version: 'V3' as const})),
      {redeemerHexFor: () => 'd87a80'},
    )
    expect(r.kind === 'ok' && r.substandards.get(REAL_HASH)?.redeemerDataHex).toBe('d87a80')
  })

  it('asks once for a hash repeated across policies', async () => {
    // Several tokens from one issuer share a transfer-logic script.
    const asked: string[] = []
    const r = await run(
      [REAL_HASH, REAL_HASH.toUpperCase()],
      withProvider((h) => {
        asked.push(h)
        return Effect.succeed({bytesHex: REAL_BYTES, version: 'V3' as const})
      }),
    )
    expect(asked).toEqual([REAL_HASH])
    expect(r.kind).toBe('ok')
  })

  it('asks for nothing when there is nothing to ask for', async () => {
    const asked: string[] = []
    const r = await run(
      [],
      withProvider((h) => {
        asked.push(h)
        return Effect.succeed(undefined)
      }),
    )
    expect(r).toEqual({kind: 'ok', substandards: new Map()})
    expect(asked).toEqual([])
  })
})
