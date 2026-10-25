// Parsing the native reader's answer. The rules that matter are the ones about *not* reading: a field
// that drifted must narrow `understood`, never round an amount or default a count to zero.
import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {midnightTxEffect} from './midnight-effect.js'
import {allUnshielded} from './midnight-facts.js'
import {readMidnightTxFactsJson} from './midnight-facts-wire.js'

/**
 * A real co-funded transfer's facts, emitted by the Rust reader itself.
 *
 * ⚠️ This is the cross-check `docs/MIDNIGHT_REVIEW_FROM_BYTES.md` listed as owed: two readers walk one
 * shape and nothing used to fail when either moved. `rust/src/facts.rs`'s
 * `the_facts_fixture_still_matches_what_this_reader_emits` holds the other end.
 */
const FIXTURE = readFileSync(new URL('./midnight-facts-fixture.json', import.meta.url), 'utf8')

/** The two contributing wallets and the recipient, as the fixture names them. */
const A = 'fdf6ad91b11bb3af29308de0e54f055d5ccb5d705f920f524bfdfdaf57b11e41'
const B = 'fa5252115b9902967388a34d4358dd25413a29794b9d0aa28307171010a2aaee'
const NIGHT = '00'.repeat(32)

const one = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    understood: true,
    networkId: 'preprod',
    shieldedOutputs: 0,
    hasShielded: false,
    intents: [
      {
        segment: 1,
        ttlSecs: 100,
        guaranteed: {inputs: [], outputs: []},
        fallible: {inputs: [], outputs: []},
        calls: [],
        deploys: [],
        otherActions: 0,
        ...over,
      },
    ],
  })

/** The facts alone, for the assertions that are about the shape rather than about the drift signal. */
const parseMidnightTxFactsJson = (json: string) => readMidnightTxFactsJson(json).facts

describe('readMidnightTxFactsJson', () => {
  it('reads a real co-funded transfer emitted by the native reader', () => {
    const facts = parseMidnightTxFactsJson(FIXTURE)
    expect(facts.understood).toBe(true)
    expect(facts.networkId).toBe('preprod')
    expect(facts.intents.map((intent) => intent.segment)).toEqual([1])
    expect(facts.intents[0]?.ttlSecs).toBe(1_800_000_000)
    const {inputs, outputs} = allUnshielded(facts)
    // Two wallets funding one payment, which is the whole point of the shape.
    expect(inputs.map((utxo) => utxo.owner).sort()).toEqual([B, A].sort())
    expect(inputs.map((utxo) => utxo.value)).toEqual([3_000_000n, 5_000_000n])
    expect(outputs.map((utxo) => utxo.value)).toEqual([1_000_000n, 1_000_000n, 6_000_000n])
    expect(facts.hasShielded).toBe(false)
  })

  it('gives a wallet only its own contribution, not the other party’s input', () => {
    // The rule that makes a co-funded review truthful: A spends 3,000,000 and gets 1,000,000 back, so
    // it is out 2,000,000 — B's 5,000,000 is not A's spend.
    const effect = midnightTxEffect({facts: parseMidnightTxFactsJson(FIXTURE), ourAddresses: [A]})
    expect(effect.delta.get(NIGHT)).toBe(-2_000_000n)
    expect(effect.understood).toBe(true)
  })

  it('reads the device’s whole side when both contributors are ours', () => {
    const effect = midnightTxEffect({facts: parseMidnightTxFactsJson(FIXTURE), ourAddresses: [A, B]})
    expect(effect.delta.get(NIGHT)).toBe(-6_000_000n)
    expect(effect.toOthers).toHaveLength(1)
    expect(effect.toOthers[0]?.value).toBe(6_000_000n)
  })

  it('keeps a large amount exact rather than rounding it through a number', () => {
    const huge = (2n ** 100n).toString()
    const facts = parseMidnightTxFactsJson(
      one({fallible: {inputs: [{colour: NIGHT, value: huge, owner: A}], outputs: []}}),
    )
    expect(facts.intents[0]?.fallible.inputs[0]?.value).toBe(2n ** 100n)
  })

  it('reports an unreadable amount as an unreadable entry rather than as zero value it can trust', () => {
    // Kept, with the empty colour that marks it — the same convention the other reader uses, and what
    // `midnightTxEffect` counts as `unreadable-entry`.
    const facts = parseMidnightTxFactsJson(
      one({fallible: {inputs: [{colour: NIGHT, value: 3_000_000, owner: A}], outputs: []}}),
    )
    expect(facts.intents[0]?.fallible.inputs[0]).toEqual({colour: '', value: 0n, owner: ''})
    const effect = midnightTxEffect({facts, ourAddresses: [A]})
    expect(effect.understood).toBe(false)
    expect(effect.gaps).toEqual([{kind: 'unreadable-entry', count: 1}])
  })

  it('counts an action it cannot name instead of dropping it', () => {
    const facts = parseMidnightTxFactsJson(one({calls: [{address: 'ab'.repeat(32)}], otherActions: 2}))
    expect(facts.intents[0]?.calls).toEqual([])
    expect(facts.intents[0]?.otherActions).toBe(3)
  })

  it('refuses to default a malformed count to zero — the intent is unreadable instead', () => {
    const facts = parseMidnightTxFactsJson(one({otherActions: 'lots'}))
    expect(facts.understood).toBe(false)
    expect(facts.intents).toEqual([])
  })

  it('narrows the native reader’s own `understood` and never widens it', () => {
    expect(
      parseMidnightTxFactsJson(
        JSON.stringify({understood: false, networkId: 'preprod', intents: [], shieldedOutputs: 0, hasShielded: false}),
      ).understood,
    ).toBe(false)
    // A `true` beside an intent list this parser could not read does not survive.
    expect(parseMidnightTxFactsJson(one({segment: -1})).understood).toBe(false)
  })

  it('says nothing about the network rather than claiming one', () => {
    const facts = parseMidnightTxFactsJson(JSON.stringify({understood: true, intents: 'nope'}))
    expect(facts.networkId).toBe('')
    expect(facts.understood).toBe(false)
  })

  it('never throws, whatever it is handed', () => {
    for (const bad of ['', 'null', '[]', '{', 'true', '"a string"']) {
      expect(() => parseMidnightTxFactsJson(bad)).not.toThrow()
      expect(parseMidnightTxFactsJson(bad).understood).toBe(false)
    }
  })

  it('reports a shielded offer as a count, never as an amount', () => {
    const facts = parseMidnightTxFactsJson(
      JSON.stringify({understood: true, networkId: 'preprod', intents: [], shieldedOutputs: 2, hasShielded: true}),
    )
    expect(facts.shieldedOutputs).toBe(2)
    expect(facts.hasShielded).toBe(true)
  })
})

// ⚠️ `unreadable` and `!understood` are different diagnoses. A rewards claim is a transaction the
// ledger read and this IR does not describe; a malformed answer is a bridge that has drifted. Both
// render the same on screen, and only one of them is a bug to go and fix.
describe('readMidnightTxFactsJson’s drift signal', () => {
  it('says the answer was not JSON', () => {
    const read = readMidnightTxFactsJson('{')
    expect(read.facts.understood).toBe(false)
    expect(read.unreadable).toContain('not JSON')
  })

  it('says the answer was the wrong shape', () => {
    expect(readMidnightTxFactsJson('[]').unreadable).toContain('not an object')
    expect(readMidnightTxFactsJson(JSON.stringify({understood: true})).unreadable).toContain('intents')
  })

  it('names how many intents it could not read', () => {
    expect(readMidnightTxFactsJson(one({otherActions: 'lots'})).unreadable).toBe('1 of 1 intents could not be read')
  })

  it('stays silent for a transaction it read but does not describe', () => {
    // What the native reader answers for a rewards claim: read perfectly, described by nothing here.
    const read = readMidnightTxFactsJson(
      JSON.stringify({understood: false, networkId: 'preprod', intents: [], shieldedOutputs: 0, hasShielded: false}),
    )
    expect(read.facts.understood).toBe(false)
    expect(read.unreadable).toBeNull()
  })

  it('stays silent for a transaction it read in full', () => {
    expect(readMidnightTxFactsJson(FIXTURE).unreadable).toBeNull()
  })
})
