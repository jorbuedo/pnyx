import type {Classify as Cip113Classify} from '@evolution-sdk/cip113'
import {describe, expect, it} from 'vitest'
import type {SendEligibility} from '../../../services/cardano/cip113/send-eligibility'
import {type AssetDisposition, dispositionOf, mayEnterBasket} from './programmable-guard'

const TEST_ID = '16b37cfebd14a0d3da5e8738333b21a145a9f6429f396199d22b67a5.54455354'
const ORDINARY = `${'aa'.repeat(28)}.4d494c4b`
const SUB = 'ab'.repeat(28)

const only = (id: string, e: SendEligibility) => (asset: string) => (asset === id ? e : undefined)

describe('dispositionOf', () => {
  it('leaves an ordinary asset alone, with no registry lookup', () => {
    expect(dispositionOf(ORDINARY, () => undefined)).toEqual({kind: 'ordinary'})
  })

  it('routes a sendable programmable token out of the basket flow', () => {
    const d = dispositionOf(
      TEST_ID,
      only(TEST_ID, {kind: 'sendable', transferLogicHashHex: SUB, seizure: {kind: 'disabled'}}),
    )
    expect(d).toEqual({kind: 'programmable', transferLogicHashHex: SUB, warnsSeizure: false})
  })

  it('warns on seizure that is possible OR unknown', () => {
    const warn = (seizure: Cip113Classify.Seizure) =>
      dispositionOf(TEST_ID, only(TEST_ID, {kind: 'sendable', transferLogicHashHex: SUB, seizure}))
    expect(warn({kind: 'possible', logic: {kind: 'script', hashHex: 'cd'}})).toMatchObject({warnsSeizure: true})
    expect(warn({kind: 'unknown', logic: {kind: 'script', hashHex: 'cd'}})).toMatchObject({warnsSeizure: true})
  })

  it('offers a token it cannot move, with the reason, rather than hiding it', () => {
    // ⚠️ The correction this file exists for. Hiding it made a token the user can see in their
    // portfolio silently unpickable — "why is my token missing" is a worse question than a
    // sentence saying its issuer gates transfers.
    const d = dispositionOf(TEST_ID, only(TEST_ID, {kind: 'needs-issuer', reason: 'substandard', detail: 'gated'}))
    expect(d).toEqual({kind: 'blocked', detail: 'gated'})
  })

  it('treats an unregistered policy as ordinary, not as blocked', () => {
    // Refusing to send a plain native asset because a registry lookup came back empty would be
    // the worse of the two failures.
    expect(dispositionOf(ORDINARY, only(ORDINARY, {kind: 'unregistered'}))).toEqual({kind: 'ordinary'})
  })
})

describe('mayEnterBasket', () => {
  it.each<[string, AssetDisposition, boolean]>([
    ['ordinary', {kind: 'ordinary'}, true],
    ['programmable', {kind: 'programmable', transferLogicHashHex: SUB, warnsSeizure: false}, false],
    ['blocked', {kind: 'blocked', detail: 'x'}, false],
  ])('%s → %s', (_name, disposition, allowed) => {
    // The invariant the ordinary build depends on: only ordinary assets are allocated across
    // recipients. A programmable one has different inputs and its own review, so there is nothing
    // for the allocate step to allocate.
    expect(mayEnterBasket(disposition)).toBe(allowed)
  })
})
