import type {Classify as Cip113Classify} from '@evolution-sdk/cip113'
import {describe, expect, it} from 'vitest'
import {sendEligibilityOf, showsSeizureWarning} from './send-eligibility'

const SUB = 'ab'.repeat(28)

const classification = (over: Partial<Cip113Classify.Cip113Classification> = {}) =>
  ({
    policyHex: '16b37cfe',
    deploymentId: 'cf-preview-2026-10-02',
    registration: 'registered',
    transferability: {kind: 'known-substandard', scriptHashHex: SUB},
    seizure: {kind: 'disabled'},
    unfracking: {kind: 'forbidden'},
    ...over,
  }) as Cip113Classify.Cip113Classification

describe('sendEligibilityOf', () => {
  it('is sendable when we hold the substandard witness', () => {
    // One of twelve live preview policies. The other eleven are the case below.
    expect(sendEligibilityOf(classification())).toMatchObject({kind: 'sendable', transferLogicHashHex: SUB})
  })

  it('carries seizure through to the send surface, not only a detail view', () => {
    const seizable = classification({seizure: {kind: 'possible', logic: {kind: 'script', hashHex: 'cd'}}})
    expect(sendEligibilityOf(seizable)).toMatchObject({seizure: {kind: 'possible'}})
  })

  it('says the issuer is needed for a substandard we cannot witness', () => {
    // ⚠️ Not an error. The holder owns the token; they cannot move it from this wallet.
    const r = sendEligibilityOf(classification({transferability: {kind: 'unknown-substandard', scriptHashHex: SUB}}))
    expect(r).toMatchObject({kind: 'needs-issuer', reason: 'substandard'})
  })

  it('distinguishes a signature gate from a script gate', () => {
    const r = sendEligibilityOf(classification({transferability: {kind: 'signature-gated', keyHashHex: 'ef'}}))
    expect(r).toMatchObject({kind: 'needs-issuer', reason: 'signature'})
  })

  it('reports an unregistered policy as such, not as un-sendable', () => {
    expect(sendEligibilityOf(classification({registration: 'unregistered'}))).toEqual({kind: 'unregistered'})
  })

  it('refuses to guess when the registry contradicts itself', () => {
    // Registered, yet transferability says not-programmable. Saying "you cannot" would be a claim
    // we have not earned, and trying anyway would build against rules we do not understand.
    const r = sendEligibilityOf(classification({transferability: {kind: 'not-programmable'}}))
    expect(r).toMatchObject({kind: 'unclassifiable'})
  })
})

describe('showsSeizureWarning', () => {
  it('warns on possible AND on unknown, clean only on disabled', () => {
    // ⚠️ `unknown` must never render as safe — it means we could not classify the seizure script,
    // which is not the same as nobody being able to seize.
    expect(showsSeizureWarning({kind: 'possible', logic: {kind: 'script', hashHex: 'cd'}})).toBe(true)
    expect(showsSeizureWarning({kind: 'unknown', logic: {kind: 'script', hashHex: 'cd'}})).toBe(true)
    expect(showsSeizureWarning({kind: 'disabled'})).toBe(false)
  })
})
