import {encodeHandle} from '@pnyx/contract-client/handle'
import {encodePnyxId} from '@pnyx/contract-client/identity'
import {encodeNightAddress} from '@pnyx/wallet'
import {describe, expect, it} from 'vitest'
import {classifyPeerInput} from './peer-input'

const pnyxId = encodePnyxId(Uint8Array.from({length: 32}, (_, i) => i + 1))
const preprodId = encodePnyxId(new Uint8Array(32).fill(9))

describe('classifyPeerInput', () => {
  it('recognises an Pnyx id on any network', () => {
    expect(classifyPeerInput(pnyxId)).toEqual({kind: 'identity', pnyxId})
    expect(classifyPeerInput(preprodId)).toEqual({kind: 'identity', pnyxId: preprodId})
  })

  it('forgives paste whitespace around an id', () => {
    expect(classifyPeerInput(`  ${pnyxId}\n`)).toEqual({kind: 'identity', pnyxId})
  })

  // convId pairs the two ids as strings, so an uppercase paste must not name a different
  // conversation than the same id typed lowercase.
  it('canonicalises an uppercase id rather than passing it through', () => {
    expect(classifyPeerInput(pnyxId.toUpperCase())).toEqual({kind: 'identity', pnyxId})
  })

  // A prefix test would accept this; a checksum decode does not. Treating it as an identity sends
  // the user into a row lookup that can only fail confusingly.
  it('does not accept a corrupted id as an identity', () => {
    const corrupted = `${pnyxId.slice(0, -1)}${pnyxId.at(-1) === 'q' ? 'p' : 'q'}`
    expect(classifyPeerInput(corrupted).kind).not.toBe('identity')
  })

  // An `mn_addr` is still a real thing in this app — it addresses a Midnight *wallet*. It is not an
  // Pnyx identity, and accepting it here would resolve to a row that cannot exist.
  it('does not accept a Midnight wallet address', () => {
    const address = encodeNightAddress(new Uint8Array(32).fill(7), 'mainnet')
    expect(classifyPeerInput(address).kind).toBe('unrecognised')
  })

  it('reads a label as an Pnyx handle', () => {
    const result = classifyPeerInput('alice')
    expect(result.kind).toBe('handle')
    if (result.kind !== 'handle') return
    expect(result.handle).toBe('alice')
    expect(result.nameKey).toEqual(encodeHandle('alice'))
  })

  it('canonicalises a handle before it becomes bytes', () => {
    // Same identity, three spellings: the bytes claimed on chain are the canonical ones, so an
    // upper-case or decomposed spelling must resolve to the same key rather than miss.
    const canonical = encodeHandle('café')
    for (const typed of ['  CAFÉ  ', 'café', 'café']) {
      const result = classifyPeerInput(typed)
      expect(result.kind).toBe('handle')
      if (result.kind === 'handle') expect(result.nameKey).toEqual(canonical)
    }
  })

  it('rejects input the handle policy refuses, rather than passing it on to fail later', () => {
    // Structural refusals only. `alicа` with a Cyrillic `а` is now a *valid* handle — a different one
    // from `alice` — because confusables are not judged by the charset; see `handle-charset.ts`.
    expect(classifyPeerInput('_alice').kind).toBe('unrecognised')
    expect(classifyPeerInput('alice\u200dbob').kind).toBe('unrecognised')
    expect(classifyPeerInput('alice\u{1F600}').kind).toBe('unrecognised')
    expect(classifyPeerInput('alicа').kind).toBe('handle')
  })

  it('accepts a short handle, since the byte floor was retired for tiers', () => {
    // `abc` was refused under the 5-byte floor. Short names are priced rather than forbidden now
    // (`docs/BOUNDED_STATE_ARCHITECTURE.md` §3.5), and a client stricter than the circuit would
    // strand names on chain that this app then refuses to resolve.
    expect(classifyPeerInput('abc').kind).toBe('handle')
    expect(classifyPeerInput('ab').kind).toBe('handle')
  })

  // A dot is not part of any handle the policy accepts, so a `.night` name — or anything else with
  // a suffix — is simply not an Pnyx name.
  it('does not treat a suffixed name as a handle', () => {
    expect(classifyPeerInput('alice.night').kind).toBe('unrecognised')
    expect(classifyPeerInput('alice.eth').kind).toBe('unrecognised')
  })

  it('reports empty separately from unrecognised', () => {
    expect(classifyPeerInput('   ').kind).toBe('empty')
  })
})
