import {describe, expect, it} from 'vitest'
import {chainBadgeState} from './chain-badge-state'

describe('chainBadgeState', () => {
  // The case the module exists for: on-chain and unusable at the same time.
  it('overrides a confirmed settlement when the contract is an older compile', () => {
    expect(chainBadgeState({status: 'confirmed', template: 'outdated'})).toBe('outdated')
  })

  it('leaves a confirmed settlement alone on the current template', () => {
    expect(chainBadgeState({status: 'confirmed', template: 'current'})).toBe('confirmed')
  })

  // Not resolved is not reassurance, and not an alarm either — it changes nothing.
  it.each(['unknown', undefined] as const)('renders the settlement unchanged when the template is %s', (template) => {
    expect(chainBadgeState({status: 'confirmed', template})).toBe('confirmed')
  })

  // A pending circle has nothing deployed to compare against, and a failed one already says the
  // louder thing — neither should be relabelled.
  it.each(['pending', 'failed'] as const)('never relabels a %s settlement', (status) => {
    expect(chainBadgeState({status, template: 'outdated'})).toBe(status)
  })

  it('renders nothing when there is no settlement at all', () => {
    expect(chainBadgeState({template: 'outdated'})).toBeUndefined()
  })
})
