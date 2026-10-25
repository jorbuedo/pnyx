import {describe, expect, it} from 'vitest'
import {HANDED_NOTE, handedAnswer} from './agent-answer'

describe('handedAnswer', () => {
  it('says the transaction is awaiting a decision, and carries what was built', () => {
    const out = handedAnswer({txHashes: ['ab'], fee: '173465'})
    expect(out).toEqual({
      ok: true,
      value: {awaitingApproval: true, txHashes: ['ab'], fee: '173465', note: HANDED_NOTE},
    })
  })

  // ⚠️ The unsigned path answers `submitted: false` and means "nothing happened, here are the bytes".
  // Reusing that word for "a person is deciding right now" would collapse two states an agent has to
  // tell apart — so neither `submitted` spelling may appear here.
  it('never claims anything about `submitted`', () => {
    const value = handedAnswer({txHash: 'ab'}).ok ? (handedAnswer({txHash: 'ab'}) as {value: object}).value : {}
    expect(Object.keys(value)).not.toContain('submitted')
  })

  // A model shown a bare flag reports the payment as made, or builds it again when no outcome arrives.
  // Both cost the person money or a second approval, so the note has to say all three things.
  it('tells the agent the decision is not its own, where to look, and not to rebuild', () => {
    expect(HANDED_NOTE).toContain('does not wait for it')
    expect(HANDED_NOTE).toContain('cardano_listOutcomes')
    expect(HANDED_NOTE).toContain('Do not build it again')
  })

  // A builder describes what it built; it may not soften what the agent is told about the state that
  // build is in. Both keys are applied after the caller's, so neither can be overridden.
  it('refuses to let a caller soften either key that carries the contract', () => {
    const out = handedAnswer({awaitingApproval: false, note: 'sent!'}) as {value: Record<string, unknown>}
    expect(out.value.note).toBe(HANDED_NOTE)
    expect(out.value.awaitingApproval).toBe(true)
  })
})
