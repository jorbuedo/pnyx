import {describe, expect, it} from 'vitest'
import {decideTemplate, MAX_LEARNED_TEMPLATES, type TemplateState} from './template-learning'

const HASH = '0x3f1c9a7e5b2d40e8aa61c7f0d9b4e2a8c5370f16bd82e49a7c035be1d6af8920'
const CONTRACT = '0x801dfcd7b50a724b83c67e7dbbc45da6d3cf4a0b4d657ad33410f69f41b52ac05b'

const state = (over: Partial<TemplateState> = {}): TemplateState => ({
  knowsBlock: (h) => h === HASH,
  callTemplates: new Set<string>(),
  storageTemplates: new Set<string>(),
  ...over,
})

describe('decideTemplate', () => {
  it('learns a call whose arguments are the same for every block', () => {
    expect(decideTemplate('archive_v1_call', [HASH, 'Core_version', '0x'], state())).toEqual({
      verdict: 'learn',
      kind: 'call',
      template: JSON.stringify(['Core_version', '0x']),
    })
  })

  it('learns a storage template', () => {
    const items = [{key: '0x26aa39', type: 'value'}]
    expect(decideTemplate('archive_v1_storage', [HASH, items, null], state())).toEqual({
      verdict: 'learn',
      kind: 'storage',
      template: JSON.stringify([items, null]),
    })
  })

  // The defect this module exists for: one of these per contract, each prefetched against every
  // block forever, is what produced 781 templates and a 21 GB footprint.
  it('refuses a call keyed by contract address, however many distinct addresses arrive', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const address = `${CONTRACT.slice(0, -2)}${i.toString(16).padStart(2, '0')}`
      const d = decideTemplate('archive_v1_call', [HASH, 'MidnightRuntimeApi_get_contract_state', address], state())
      expect(d).toEqual({verdict: 'entity-keyed', call: 'MidnightRuntimeApi_get_contract_state'})
      if (d.verdict === 'learn') seen.add(d.template)
    }
    expect(seen.size).toBe(0)
  })

  it('caps the learned set so the next per-entity method cannot unbound it either', () => {
    const callTemplates = new Set<string>(
      Array.from({length: MAX_LEARNED_TEMPLATES}, (_, i) => JSON.stringify([`Some_future_api_${i}`, '0x'])),
    )
    expect(decideTemplate('archive_v1_call', [HASH, 'One_too_many', '0x'], state({callTemplates}))).toEqual({
      verdict: 'cap-reached',
      kind: 'call',
      template: JSON.stringify(['One_too_many', '0x']),
      cap: MAX_LEARNED_TEMPLATES,
    })
  })

  it('still learns while one short of the cap', () => {
    const callTemplates = new Set<string>(
      Array.from({length: MAX_LEARNED_TEMPLATES - 1}, (_, i) => JSON.stringify([`Some_future_api_${i}`, '0x'])),
    )
    expect(decideTemplate('archive_v1_call', [HASH, 'Last_slot', '0x'], state({callTemplates})).verdict).toBe('learn')
  })

  it('caps call and storage independently', () => {
    const callTemplates = new Set<string>(
      Array.from({length: MAX_LEARNED_TEMPLATES}, (_, i) => JSON.stringify([`Some_future_api_${i}`, '0x'])),
    )
    expect(decideTemplate('archive_v1_storage', [HASH, [{key: '0x01'}], null], state({callTemplates})).verdict).toBe(
      'learn',
    )
  })

  it('reports a template it already holds rather than relearning it', () => {
    const template = JSON.stringify(['Core_version', '0x'])
    expect(
      decideTemplate('archive_v1_call', [HASH, 'Core_version', '0x'], state({callTemplates: new Set([template])})),
    ).toEqual({verdict: 'already-known', kind: 'call', template})
  })

  it('ignores a request against a block it has never seen', () => {
    const d = decideTemplate('archive_v1_call', ['0xdeadbeef', 'Core_version', '0x'], state())
    expect(d).toEqual({verdict: 'unknown-block'})
  })

  it('ignores methods that are not prefetchable per-block calls', () => {
    for (const method of ['archive_v1_header', 'archive_v1_body', 'chainHead_v1_follow', 'rpc_methods']) {
      expect(decideTemplate(method, [HASH, 'Core_version', '0x'], state())).toEqual({verdict: 'not-a-template'})
    }
  })

  it('ignores a call with the wrong arity rather than building a half template', () => {
    expect(decideTemplate('archive_v1_call', [HASH, 'Core_version'], state())).toEqual({verdict: 'not-a-template'})
    expect(decideTemplate('archive_v1_call', [HASH, 'Core_version', '0x', 'extra'], state())).toEqual({
      verdict: 'not-a-template',
    })
  })

  it('ignores params that are not an array of a block hash first', () => {
    for (const params of [undefined, null, {}, [], [42, 'Core_version', '0x'], 'a string']) {
      expect(decideTemplate('archive_v1_call', params, state())).toEqual({verdict: 'not-a-template'})
    }
  })

  it('does not treat the entity-keyed name as special on the storage path', () => {
    // The exclusion is about `archive_v1_call`'s function argument; a storage request is shaped
    // differently and must not be matched against it by accident.
    const items = [{key: 'MidnightRuntimeApi_get_contract_state', type: 'value'}]
    expect(decideTemplate('archive_v1_storage', [HASH, items, null], state()).verdict).toBe('learn')
  })
})
