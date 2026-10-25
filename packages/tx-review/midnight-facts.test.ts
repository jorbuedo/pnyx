// Reading a Midnight transaction rather than trusting its caller. The rules that matter are the ones
// about *not knowing*: an unreadable shape must not read as "does nothing", and a shielded offer must
// not read as an amount.
import {describe, expect, it} from 'vitest'
import {allUnshielded, readMidnightTxFacts} from './midnight-facts.js'

const utxo = (type: string, value: bigint, owner: string) => ({type, value, owner})

const intent = (over: Record<string, unknown> = {}) => ({
  actions: [],
  guaranteedUnshieldedOffer: undefined,
  fallibleUnshieldedOffer: undefined,
  ...over,
})

const tx = (intents: Iterable<readonly [number, unknown]>, over: Record<string, unknown> = {}) => ({
  intents: new Map(intents),
  ...over,
})

describe('readMidnightTxFacts', () => {
  it('reads an unshielded transfer’s inputs and outputs with colour, value and owner', () => {
    const facts = readMidnightTxFacts(
      tx([
        [
          1,
          intent({
            fallibleUnshieldedOffer: {
              inputs: [utxo('AA'.repeat(32), 5_000n, 'BB'.repeat(32))],
              outputs: [utxo('AA'.repeat(32), 2_000n, 'CC'.repeat(32))],
            },
          }),
        ],
      ]),
    )
    expect(facts.understood).toBe(true)
    const {inputs, outputs} = allUnshielded(facts)
    // Lowercased, because an address compared case-sensitively against our own would never match.
    expect(inputs[0]).toEqual({colour: 'aa'.repeat(32), value: 5_000n, owner: 'bb'.repeat(32)})
    expect(outputs[0]?.value).toBe(2_000n)
  })

  it('keeps the two sections apart — fees are taken in the guaranteed one', () => {
    const facts = readMidnightTxFacts(
      tx([
        [
          1,
          intent({
            guaranteedUnshieldedOffer: {inputs: [utxo('aa', 1n, 'bb')], outputs: []},
            fallibleUnshieldedOffer: {inputs: [], outputs: [utxo('aa', 1n, 'cc')]},
          }),
        ],
      ]),
    )
    expect(facts.intents[0]?.guaranteed.inputs).toHaveLength(1)
    expect(facts.intents[0]?.fallible.outputs).toHaveLength(1)
  })

  it('orders intents by segment, because a deficit is only fundable from its own', () => {
    const facts = readMidnightTxFacts(
      tx([
        [7, intent()],
        [2, intent()],
        [4, intent()],
      ]),
    )
    expect(facts.intents.map((one) => one.segment)).toEqual([2, 4, 7])
  })

  it('classifies calls, deploys, and counts what it cannot classify', () => {
    const facts = readMidnightTxFacts(
      tx([
        [
          1,
          intent({
            actions: [
              {address: 'c1', entryPoint: 'vote'},
              {address: 'c2', initialState: {}},
              {address: 'c3'},
              {somethingElse: true},
            ],
          }),
        ],
      ]),
    )
    const one = facts.intents[0]
    expect(one?.calls).toEqual([{address: 'c1', entryPoint: 'vote'}])
    expect(one?.deploys).toEqual([{address: 'c2'}])
    // ⚠️ Counted, not dropped: silently ignoring an action turns "we could not classify this" into
    // "there was nothing there".
    expect(one?.otherActions).toBe(2)
  })

  it('⚠️ reports a shielded offer as a COUNT and never as an amount', () => {
    const facts = readMidnightTxFacts(
      tx([[1, intent()]], {guaranteedOffer: {outputs: [{}, {}]}, fallibleOffer: {size: 1, outputs: [{}]}}),
    )
    expect(facts.hasShielded).toBe(true)
    expect(facts.shieldedOutputs).toBe(3)
    // Nothing in the facts carries a shielded value, because nothing without the key could.
    expect(JSON.stringify(facts)).not.toContain('shieldedValue')
  })

  it('says a transaction with no shielded part has none, rather than leaving it unknown', () => {
    const facts = readMidnightTxFacts(tx([[1, intent()]]))
    expect(facts.hasShielded).toBe(false)
    expect(facts.shieldedOutputs).toBe(0)
  })

  it('⚠️ reports a shape it does not understand as NOT understood, not as an empty transaction', () => {
    // The whole point of the flag. Empty facts with `understood: true` would render as "this
    // transaction does nothing", which is the one wrong thing to tell someone about to sign.
    for (const bad of [null, undefined, {}, {intents: []}, {intents: 'nope'}]) {
      expect(readMidnightTxFacts(bad).understood).toBe(false)
    }
  })

  it('still reports the shielded part of a transaction whose intents it could not walk', () => {
    // Partial knowledge is worth more than none, as long as `understood` says it is partial.
    const facts = readMidnightTxFacts({intents: 'nope', guaranteedOffer: {outputs: [{}]}})
    expect(facts.understood).toBe(false)
    expect(facts.hasShielded).toBe(true)
    expect(facts.shieldedOutputs).toBe(1)
  })

  it('keeps an entry whose fields are unreadable rather than dropping it', () => {
    // A dropped input makes the transaction look smaller than it is — worse than one shown as unknown.
    const facts = readMidnightTxFacts(tx([[1, intent({fallibleUnshieldedOffer: {inputs: [{}], outputs: []}})]]))
    expect(allUnshielded(facts).inputs).toEqual([{colour: '', value: 0n, owner: ''}])
  })

  it('never throws on a hostile shape', () => {
    for (const bad of [{intents: new Map([[1, null]])}, {intents: new Map([[1, {actions: 'no'}]])}]) {
      expect(() => readMidnightTxFacts(bad)).not.toThrow()
    }
  })
})
