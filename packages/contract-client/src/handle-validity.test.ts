import {describe, expect, it} from 'vitest'
import {encodeDisplayName, encodeHandle} from './handle.js'
import {type HandleFacts, handleOwnership, handleValidity} from './handle-validity.js'

const C = new Uint8Array(32).fill(0x2a)
const OTHER = new Uint8Array(32).fill(0x2b)
const NAME = 'Sablewind-Harborlighted'

const facts = (over: Partial<HandleFacts> = {}): HandleFacts => ({
  name: encodeHandle(NAME),
  owner: C,
  banned: false,
  burned: false,
  ...over,
})

describe('handleValidity', () => {
  it('is valid when both sides agree, and returns the row’s spelling', () => {
    const result = handleValidity(facts(), encodeDisplayName(NAME), C)
    expect(result).toEqual({kind: 'valid', display: NAME})
  })

  /**
   * ⚠️ The comparison this rule exists for. The contract seals the **folded** name and the row holds the
   * case its owner chose, so a literal comparison fails for every capitalised name — which would make
   * the rule reject exactly the names it is meant to confirm.
   */
  it('folds both sides, so case never decides validity', () => {
    const result = handleValidity(facts({name: encodeHandle('sablewind-harborlighted')}), encodeDisplayName(NAME), C)
    expect(result.kind).toBe('valid')
  })

  // ⚠️ The attack a one-sided check allows: anyone may write any name into their own row.
  it('refuses a row that names a handle this identity does not own', () => {
    expect(handleValidity(facts({owner: OTHER}), encodeDisplayName(NAME), C)).toEqual({kind: 'other-owner'})
  })

  // ⚠️ The other one-sided failure: an owner whose row names something else is displaying nothing.
  it('refuses an owner whose row names a different handle', () => {
    const other = encodeDisplayName('someotherlongenoughname')
    expect(handleValidity(facts(), other, C)).toEqual({kind: 'not-displayed'})
  })

  /**
   * The state two names are in on preprod right now: `bind` landed, `setPrimaryName` did not. The holder
   * owns it and is not displaying it — which is neither an error nor a name anyone else may take.
   */
  it('reports an owned name whose row is empty as not displayed', () => {
    expect(handleValidity(facts(), new Uint8Array(32), C).kind).toBe('unrenderable')
  })

  it('reports a deployed shell nobody has bound', () => {
    expect(handleValidity(facts({owner: undefined}), encodeDisplayName(NAME), C)).toEqual({kind: 'unbound'})
  })

  // Burned and banned come first: a name in either state must not render whatever else agrees.
  it('refuses a burned name even when everything else agrees', () => {
    expect(handleValidity(facts({burned: true}), encodeDisplayName(NAME), C)).toEqual({kind: 'burned'})
  })

  it('refuses a banned name even when everything else agrees', () => {
    expect(handleValidity(facts({banned: true}), encodeDisplayName(NAME), C)).toEqual({kind: 'banned'})
  })

  it('prefers burned over banned when both are set', () => {
    expect(handleValidity(facts({banned: true, burned: true}), encodeDisplayName(NAME), C).kind).toBe('burned')
  })
})

describe('handleOwnership', () => {
  it('tells this identity’s own name from somebody else’s', () => {
    expect(handleOwnership(facts({owner: C}), C)).toBe('mine')
    expect(handleOwnership(facts({owner: OTHER}), C)).toBe('someone-else')
  })

  // ⚠️ The distinction a claim turns on. `bind` asserts an unowned shell, so a claim that cannot tell
  // these apart reports the owner's own name as taken and can never be finished — which is the state
  // two preprod names were left in.
  it('separates an unbound shell from one this identity holds', () => {
    expect(handleOwnership(facts({owner: undefined}), C)).toBe('unbound')
    expect(handleOwnership(facts({owner: C}), C)).not.toBe('unbound')
  })

  // An all-zero commitment is a real identity's `C` as far as a comparison is concerned, so an unbound
  // shell must be *absent*, never zeroes. This pins that reading.
  it('does not read an unbound shell as owned by the zero identity', () => {
    expect(handleOwnership(facts({owner: undefined}), new Uint8Array(32))).toBe('unbound')
  })

  it('reports a moderated name before it reports an owner', () => {
    expect(handleOwnership(facts({owner: C, banned: true}), C)).toBe('banned')
    expect(handleOwnership(facts({owner: C, burned: true}), C)).toBe('burned')
    // Burned outranks banned: it is the one that can never be undone.
    expect(handleOwnership(facts({owner: C, banned: true, burned: true}), C)).toBe('burned')
  })

  it('is the same comparison handleValidity makes', () => {
    expect(handleValidity(facts({owner: OTHER}), encodeDisplayName(NAME), C).kind).toBe('other-owner')
    expect(handleValidity(facts({owner: undefined}), encodeDisplayName(NAME), C).kind).toBe('unbound')
  })
})
