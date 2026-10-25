// @vitest-environment node
//
// ⚠️ **The environment annotation above is load-bearing.** These tests exist because `runSignTx`
// referenced a free `origin`, which `tsc` accepted (the app's `lib` includes `DOM`, so it resolved to
// `window.origin`) and Hermes threw on. Under `node` there is no `globalThis.origin`, so an unbound
// `origin` is a ReferenceError here too — which is the only reason a test can catch this class at all.
// Under `jsdom` the global comes back and the bug becomes invisible again, at runtime and not just in
// tsc. So if this app ever switches to jsdom by default, this file must stay on node.
//
// Raised by the glacier-redeem session, which found the original bug.
import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

const SOURCE = readFileSync(fileURLToPath(new URL('./dapp-signing.ts', import.meta.url)), 'utf8')

/** The parameter block of one exported arrow function, from its name to the closing `}): Promise`. */
const paramsOf = (fn: string): string => {
  const start = SOURCE.indexOf(`export const ${fn} = async (params: {`)
  expect(start, `${fn} not found — was it renamed?`).toBeGreaterThan(-1)
  const end = SOURCE.indexOf('}): Promise', start)
  return SOURCE.slice(start, end)
}

/** The `const {…} = params` line inside one function. */
const destructureOf = (fn: string): string => {
  const start = SOURCE.indexOf(`export const ${fn} = async (params: {`)
  const from = SOURCE.indexOf('const {', SOURCE.indexOf('}): Promise', start))
  return SOURCE.slice(from, SOURCE.indexOf('\n', from))
}

describe('a signing function that records an origin must receive one', () => {
  // The bug: `audit: {purpose: 'dapp-tx', origin}` with no `origin` parameter. A free identifier that
  // resolves to `window.origin` under `lib: DOM` and throws under Hermes, so every dApp `signTx` failed
  // with "Property 'origin' doesn't exist" while the build stayed green.
  it.each(['runSignTx', 'runSignData'])('%s declares origin in its params', (fn) => {
    expect(paramsOf(fn)).toMatch(/readonly origin:/)
  })

  it.each(['runSignTx', 'runSignData'])('%s destructures origin from params', (fn) => {
    expect(destructureOf(fn)).toMatch(/\borigin\b/)
  })

  // Belt and braces on the actual failure mode: if a function builds an audit entry with a shorthand
  // `origin`, that name has to be bound in the same function. Checked by position rather than by
  // parsing, which is enough to catch the shape that shipped.
  it('binds origin in every function that puts it in an audit entry', () => {
    for (const fn of ['runSignTx', 'runSignData']) {
      const start = SOURCE.indexOf(`export const ${fn} = async (params: {`)
      const next = SOURCE.indexOf('\nexport const ', start + 1)
      const body = SOURCE.slice(start, next === -1 ? SOURCE.length : next)
      if (!/audit: \{[^}]*\borigin\b/.test(body)) continue
      expect(body, `${fn} records origin in its audit entry without binding it`).toMatch(
        /const \{[^}]*\borigin\b[^}]*\} = params/,
      )
    }
  })
})

describe('the environment this file runs in', () => {
  // If this ever fails, the guard above has been blinded: a DOM-ish global means an unbound `origin`
  // stops throwing and starts silently resolving, exactly as it did under tsc.
  it('has no DOM origin global, which is what makes an unbound origin observable', () => {
    expect((globalThis as {origin?: unknown}).origin).toBeUndefined()
  })
})
