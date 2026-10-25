import {describe, expect, it} from 'vitest'
import {
  flatTemplate,
  hasTimeLock,
  isSatisfied,
  type ScriptTemplate,
  signPolicy,
  tagAt,
  templateFromJson,
  templateTags,
  templateToJson,
  validateTemplate,
  validityBounds,
  withTimeLock,
} from './template'

const sig = (tag: string): ScriptTemplate => ({kind: 'cosigner', tag})
const A = tagAt(0)
const B = tagAt(1)
const C = tagAt(2)
const signed = (...tags: string[]) => new Set(tags)

describe('templateTags', () => {
  it('collects tags in first-appearance order, deduped', () => {
    const t: ScriptTemplate = {kind: 'all', scripts: [sig(B), {kind: 'any', scripts: [sig(A), sig(B)]}, sig(C)]}
    expect(templateTags(t)).toEqual([B, A, C])
  })

  it('ignores time-lock leaves', () => {
    expect(templateTags({kind: 'all', scripts: [sig(A), {kind: 'invalidBefore', slot: 10n}]})).toEqual([A])
  })
})

describe('signPolicy', () => {
  it('matches the flat quorum kinds', () => {
    expect(signPolicy(flatTemplate({kind: 'all'}, [A, B, C]))).toEqual({required: 3, total: 3})
    expect(signPolicy(flatTemplate({kind: 'any'}, [A, B, C]))).toEqual({required: 1, total: 3})
    expect(signPolicy(flatTemplate({kind: 'atLeast', n: 2}, [A, B, C]))).toEqual({required: 2, total: 3})
  })

  it('costs at_least by its n cheapest branches, not its branch count', () => {
    // at_least 2 [a, all[b,c]] is satisfiable with a + (b,c) = 3 signatures,
    // but the cheapest two branches are a(1) and all[b,c](2).
    const t: ScriptTemplate = {kind: 'atLeast', n: 2, scripts: [sig(A), {kind: 'all', scripts: [sig(B), sig(C)]}]}
    expect(signPolicy(t)).toEqual({required: 3, total: 3})
  })

  it('a time lock costs no signature', () => {
    const t = withTimeLock(flatTemplate({kind: 'atLeast', n: 2}, [A, B, C]), {from: 100n})
    expect(signPolicy(t)).toEqual({required: 2, total: 3})
  })

  it('counts a repeated tag once in the total', () => {
    expect(signPolicy({kind: 'all', scripts: [sig(A), sig(A)]}).total).toBe(1)
  })
})

describe('isSatisfied', () => {
  const twoOfThree = flatTemplate({kind: 'atLeast', n: 2}, [A, B, C])

  it('is unmet below the threshold and met at it', () => {
    expect(isSatisfied(twoOfThree, signed(A))).toBe(false)
    expect(isSatisfied(twoOfThree, signed(A, C))).toBe(true)
  })

  it('evaluates nesting structurally rather than by count', () => {
    // all [a, any [b, c]] — two signatures, but only the right two.
    const t: ScriptTemplate = {kind: 'all', scripts: [sig(A), {kind: 'any', scripts: [sig(B), sig(C)]}]}
    expect(isSatisfied(t, signed(B, C))).toBe(false) // two signatures, still unmet
    expect(isSatisfied(t, signed(A, C))).toBe(true)
  })

  it('treats a time lock as satisfied — the validity interval carries it, not a signature', () => {
    const t = withTimeLock(flatTemplate({kind: 'all'}, [A]), {until: 500n})
    expect(isSatisfied(t, signed(A))).toBe(true)
  })
})

describe('validityBounds + hasTimeLock', () => {
  it('reports no bounds for a plain template', () => {
    expect(hasTimeLock(flatTemplate({kind: 'all'}, [A]))).toBe(false)
    expect(validityBounds(flatTemplate({kind: 'all'}, [A]))).toEqual({from: null, until: null})
  })

  it('intersects to the tightest bounds', () => {
    const t: ScriptTemplate = {
      kind: 'all',
      scripts: [sig(A), {kind: 'invalidBefore', slot: 10n}, {kind: 'invalidBefore', slot: 40n}],
    }
    expect(validityBounds(t)).toEqual({from: 40n, until: null})
  })

  it('carries both bounds through withTimeLock', () => {
    const t = withTimeLock(flatTemplate({kind: 'all'}, [A]), {from: 10n, until: 90n})
    expect(hasTimeLock(t)).toBe(true)
    expect(validityBounds(t)).toEqual({from: 10n, until: 90n})
  })

  it('leaves the template untouched when no bounds are given', () => {
    const base = flatTemplate({kind: 'all'}, [A])
    expect(withTimeLock(base, {})).toBe(base)
  })
})

describe('validateTemplate', () => {
  it('accepts a well-formed roster template', () => {
    expect(validateTemplate(flatTemplate({kind: 'atLeast', n: 2}, [A, B, C]), [A, B, C])).toEqual([])
  })

  it('rejects a threshold above the branch count', () => {
    const t = flatTemplate({kind: 'atLeast', n: 4}, [A, B, C])
    expect(validateTemplate(t, [A, B, C])).toContainEqual({kind: 'threshold-out-of-range', n: 4, available: 3})
  })

  it('rejects a threshold of zero', () => {
    const t = flatTemplate({kind: 'atLeast', n: 0}, [A, B])
    expect(validateTemplate(t, [A, B])).toContainEqual({kind: 'threshold-out-of-range', n: 0, available: 2})
  })

  it('rejects a tag with no co-signer behind it', () => {
    expect(validateTemplate(flatTemplate({kind: 'all'}, [A, B]), [A])).toContainEqual({kind: 'unknown-tag', tag: B})
  })

  it('rejects an empty branch', () => {
    expect(validateTemplate({kind: 'all', scripts: []}, [])).toContainEqual({kind: 'empty-branch'})
  })

  it('rejects a template naming no signer at all', () => {
    expect(validateTemplate({kind: 'invalidBefore', slot: 1n}, [])).toContainEqual({kind: 'no-signers'})
  })

  it('rejects time locks that can never both hold', () => {
    const t = withTimeLock(flatTemplate({kind: 'all'}, [A]), {from: 900n, until: 100n})
    expect(validateTemplate(t, [A])).toContainEqual({kind: 'inverted-time-lock', from: 900n, until: 100n})
  })

  it('reports every problem at once rather than the first', () => {
    const t: ScriptTemplate = {kind: 'atLeast', n: 9, scripts: [sig(A), sig(B)]}
    const problems = validateTemplate(t, [A])
    expect(problems).toContainEqual({kind: 'threshold-out-of-range', n: 9, available: 2})
    expect(problems).toContainEqual({kind: 'unknown-tag', tag: B})
  })
})

describe('templateToJson / templateFromJson', () => {
  it('round-trips every node kind, slots included', () => {
    const template: ScriptTemplate = {
      kind: 'all',
      scripts: [
        {
          kind: 'atLeast',
          n: 2,
          scripts: [
            {kind: 'cosigner', tag: 'cosigner#0'},
            {kind: 'cosigner', tag: 'cosigner#1'},
          ],
        },
        {kind: 'any', scripts: [{kind: 'cosigner', tag: 'cosigner#2'}]},
        {kind: 'invalidBefore', slot: 1n},
        {kind: 'invalidHereafter', slot: 9_007_199_254_740_993n},
      ],
    }
    expect(templateFromJson(templateToJson(template))).toEqual(template)
  })

  it('serializes a slot as a decimal string, never a number', () => {
    const json = templateToJson({kind: 'invalidHereafter', slot: 9_007_199_254_740_993n})
    expect(JSON.stringify(json)).toContain('"9007199254740993"')
  })

  it('refuses anything that is not a template', () => {
    for (const bad of [null, undefined, 42, 'cosigner', [], {}, {kind: 'nope'}]) {
      expect(templateFromJson(bad)).toBeNull()
    }
  })

  it('refuses a branch with no children', () => {
    expect(templateFromJson({kind: 'all', scripts: []})).toBeNull()
    expect(templateFromJson({kind: 'any', scripts: 'x'})).toBeNull()
  })

  it('refuses a quorum that can never be met', () => {
    expect(templateFromJson({kind: 'atLeast', n: 3, scripts: [{kind: 'cosigner', tag: 'cosigner#0'}]})).toBeNull()
    expect(templateFromJson({kind: 'atLeast', n: 0, scripts: [{kind: 'cosigner', tag: 'cosigner#0'}]})).toBeNull()
    expect(templateFromJson({kind: 'atLeast', n: 1.5, scripts: [{kind: 'cosigner', tag: 'cosigner#0'}]})).toBeNull()
  })

  it('refuses an empty tag, and a slot that is not plain digits', () => {
    expect(templateFromJson({kind: 'cosigner', tag: ''})).toBeNull()
    for (const slot of ['0x10', ' 1 ', '-1', '', 1]) {
      expect(templateFromJson({kind: 'invalidBefore', slot})).toBeNull()
    }
  })

  it('rejects one bad leaf rather than dropping it from the branch', () => {
    expect(
      templateFromJson({
        kind: 'all',
        scripts: [
          {kind: 'cosigner', tag: 'cosigner#0'},
          {kind: 'cosigner', tag: ''},
        ],
      }),
    ).toBeNull()
  })
})
