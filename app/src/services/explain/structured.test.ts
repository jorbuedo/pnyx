import {describe, expect, it} from 'vitest'

import type {ExplainFacts} from './facts'
import {composeStructuredExplanation, type ExplainDirection, expectedDirectionOf, explainSchema} from './structured'

const facts = (over: Partial<ExplainFacts> = {}): ExplainFacts => ({
  chain: 'cardano',
  contextPacks: [],
  identityParties: 0,
  signatures: null,
  status: 'confirmed',
  feeLovelace: '170561',
  ownDeltas: [{assetId: null, delta: '-5000000', nameUnverified: null}],
  counterparties: [],
  ownParties: 1,
  escrowParties: 0,
  operations: [],
  minted: [],
  warnings: [],
  untrusted: [],
  truncated: {assets: 0, untrusted: 0, operations: 0},
  ...over,
})

const answer = (over: Record<string, unknown> = {}) => ({
  direction: 'sent',
  summary: 'You sent 5 ADA.',
  cost: 'The network fee was 0.170561 ADA.',
  ...over,
})

describe('expectedDirectionOf', () => {
  it('reads a net outflow as sent', () => {
    expect(expectedDirectionOf(facts())).toBe('sent')
  })

  it('reads a net inflow as received', () => {
    expect(expectedDirectionOf(facts({ownDeltas: [{assetId: null, delta: '5000000', nameUnverified: null}]}))).toBe(
      'received',
    )
  })

  it('reads a transaction that only pays its own fee as feeOnly', () => {
    const feeOnly = facts({ownDeltas: [{assetId: null, delta: '-170561', nameUnverified: null}]})
    expect(expectedDirectionOf(feeOnly)).toBe('feeOnly')
  })

  it('treats no deltas as feeOnly, matching what the prompt states', () => {
    expect(expectedDirectionOf(facts({ownDeltas: []}))).toBe('feeOnly')
  })

  it('reads ADA out with a token in as mixed', () => {
    const swap = facts({
      ownDeltas: [
        {assetId: null, delta: '-5000000', nameUnverified: null},
        {assetId: 'policy.name', delta: '42', nameUnverified: null},
      ],
    })
    expect(expectedDirectionOf(swap)).toBe('mixed')
  })

  it('does not read a fee-equal outflow as feeOnly when a counterparty was paid', () => {
    const paid = facts({
      ownDeltas: [{assetId: null, delta: '-170561', nameUnverified: null}],
      counterparties: [{known: null, received: [{assetId: null, delta: '1', nameUnverified: null}]}],
    })
    expect(expectedDirectionOf(paid)).toBe('sent')
  })
})

describe('composeStructuredExplanation', () => {
  const sent = {direction: 'sent' as ExplainDirection, requiresSafety: false}

  it('composes the fields in order when the direction matches', () => {
    const result = composeStructuredExplanation(answer(), sent)
    expect(result).toEqual({
      ok: true,
      text: 'You sent 5 ADA. The network fee was 0.170561 ADA.',
      droppedUnfoundedSafety: false,
    })
  })

  // The iOS failure this module exists for: facts said received, the model said sent.
  it('rejects an answer whose direction contradicts the facts', () => {
    const result = composeStructuredExplanation(answer({direction: 'sent'}), {
      direction: 'received',
      requiresSafety: false,
    })
    expect(result).toEqual({ok: false, reason: 'direction-mismatch'})
  })

  it('rejects a direction outside the closed set', () => {
    expect(composeStructuredExplanation(answer({direction: 'transferred'}), sent)).toEqual({
      ok: false,
      reason: 'direction-missing',
    })
  })

  it('rejects a missing direction', () => {
    const {direction: _omitted, ...rest} = answer()
    expect(composeStructuredExplanation(rest, sent)).toEqual({ok: false, reason: 'direction-missing'})
  })

  // The other iOS failure: a mandatory SAFETY line dropped with the rule in the prompt.
  it('rejects an empty safety field when the facts carried a safety line', () => {
    expect(composeStructuredExplanation(answer({safety: '   '}), {...sent, requiresSafety: true})).toEqual({
      ok: false,
      reason: 'safety-missing',
    })
  })

  it('rejects an absent safety field when the facts carried a safety line', () => {
    expect(composeStructuredExplanation(answer(), {...sent, requiresSafety: true})).toEqual({
      ok: false,
      reason: 'safety-missing',
    })
  })

  it('leads with the safety restatement when one is required', () => {
    const result = composeStructuredExplanation(
      answer({safety: 'Some inputs could not be read, so this may be incomplete.'}),
      {...sent, requiresSafety: true},
    )
    expect(result).toEqual({
      ok: true,
      text: 'Some inputs could not be read, so this may be incomplete. You sent 5 ADA. The network fee was 0.170561 ADA.',
      droppedUnfoundedSafety: false,
    })
  })

  it('rejects an empty summary rather than rendering a bare fee sentence', () => {
    expect(composeStructuredExplanation(answer({summary: ''}), sent)).toEqual({ok: false, reason: 'summary-empty'})
  })

  it('tolerates a missing cost field', () => {
    const {cost: _omitted, ...rest} = answer()
    expect(composeStructuredExplanation(rest, sent)).toEqual({
      ok: true,
      text: 'You sent 5 ADA.',
      droppedUnfoundedSafety: false,
    })
  })

  it.each([[null], [undefined], ['a string'], [42]])('rejects a non-object answer (%p)', (raw) => {
    expect(composeStructuredExplanation(raw, sent)).toEqual({ok: false, reason: 'malformed'})
  })

  // The first real iOS structured run joined into "…is not known You received 5 ADA."
  it('supplies the terminal punctuation the model left off, so fields do not run together', () => {
    const result = composeStructuredExplanation(
      answer({safety: 'Some inputs could not be read', summary: 'You received 5 ADA', cost: 'The fee was 0.17 ADA'}),
      {...sent, requiresSafety: true},
    )
    expect(result).toEqual({
      ok: true,
      text: 'Some inputs could not be read. You received 5 ADA. The fee was 0.17 ADA.',
      droppedUnfoundedSafety: false,
    })
  })

  it.each(['Done.', 'Really?', 'Careful!', 'and so on…'])('leaves existing punctuation alone (%s)', (summary) => {
    const result = composeStructuredExplanation(answer({summary, cost: ''}), sent)
    expect(result).toEqual({ok: true, text: summary, droppedUnfoundedSafety: false})
  })

  // Observed on the first real iOS run against a transaction with no SAFETY line: the
  // model filled the slot with "Do not send any more money to this address..." — an
  // invented warning plus the financial advice the prompt forbids.
  it('discards a warning the facts do not support, and says it did', () => {
    const invented = 'Do not send any more money to this address. You could lose your ADA.'
    const result = composeStructuredExplanation(answer({safety: invented}), sent)
    expect(result).toEqual({
      ok: true,
      text: 'You sent 5 ADA. The network fee was 0.170561 ADA.',
      droppedUnfoundedSafety: true,
    })
  })

  it('does not flag a drop when the model correctly left the slot empty', () => {
    const result = composeStructuredExplanation(answer({safety: ''}), sent)
    expect(result).toEqual({
      ok: true,
      text: 'You sent 5 ADA. The network fee was 0.170561 ADA.',
      droppedUnfoundedSafety: false,
    })
  })

  it('strips a leaked internal label out of a field', () => {
    const result = composeStructuredExplanation(answer({summary: 'SAFETY: You sent 5 ADA.'}), sent)
    expect(result.ok).toBe(true)
    expect(result.ok && result.text).not.toContain('SAFETY:')
  })
})

describe('explainSchema', () => {
  it('pins direction to the set the verifier checks against', () => {
    const schema = explainSchema()
    const direction = schema.type === 'object' ? schema.properties.find((p) => p.name === 'direction') : undefined
    expect(direction?.schema).toEqual({type: 'enum', values: ['sent', 'received', 'feeOnly', 'mixed']})
  })

  it('marks only safety optional, so the others cannot come back absent', () => {
    const schema = explainSchema()
    const optional = schema.type === 'object' ? schema.properties.filter((p) => p.optional === true) : []
    expect(optional.map((p) => p.name)).toEqual(['safety'])
  })
})
