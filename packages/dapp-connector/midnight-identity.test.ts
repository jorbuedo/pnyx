// What the Midnight "show as" setting has to actually achieve: a dApp looking for a specific wallet
// finds this one. Asserted against the detection a real dApp ships rather than against our own idea
// of it — see ASCEND_PICK below.
import {describe, expect, it} from 'vitest'
import {generateInjectionScript} from './injection.js'

const base = {
  walletName: 'Pnyx',
  apiVersion: '1',
  sessionId: 'session-abc',
  providerNames: ['pnyx'] as const,
  midnightApiVersion: '4.1.0',
  midnightRdns: 'uk.pxkq.pnyx',
  midnightUuid: '11111111-2222-3333-4444-555555555555',
}

type Initial = {rdns: string; name: string; connect: (n: string) => unknown}

const install = (midnightIdentity?: {name: string; keys: readonly string[]}) => {
  const fakeWindow: Record<string, unknown> = {
    ReactNativeWebView: {postMessage: () => {}},
    location: {origin: 'https://dapp.example'},
    addEventListener: () => {},
    dispatchEvent: () => true,
  }
  const script = generateInjectionScript({...base, ...(midnightIdentity ? {midnightIdentity} : {})})
  new Function('window', 'setTimeout', 'clearTimeout', script)(
    fakeWindow,
    () => 0,
    () => {},
  )
  return (fakeWindow.midnight ?? {}) as Record<string, Initial | undefined>
}

/**
 * Ascend's shipped wallet picker, transcribed from `dex.ascend.market`'s bundle on 2026-09-21
 * (chunk `478-813f4d56fb140d1d.js`). Kept verbatim in shape because the point of the test is that
 * *their* logic finds us, not that ours does.
 *
 * ⚠️ It never reads `rdns`. The match is on the registry key and the reported name, together.
 */
const ASCEND_PICK = (
  registry: Record<string, Initial | undefined>,
  want: string,
): {key: string; provider: Initial | undefined; byName: boolean} | undefined => {
  const entries = Object.entries(registry).filter(([, p]) => p && typeof p.connect === 'function')
  const hit = entries.find(([key, p]) => `${key} ${p?.name ?? ''}`.toLowerCase().includes(want))
  const picked = hit ?? entries[0]
  return picked === undefined ? undefined : {key: picked[0], provider: picked[1], byName: hit !== undefined}
}

describe('Midnight identity', () => {
  it('defaults to the Cardano wallet name and the UUID slot alone', () => {
    const registry = install()
    expect(Object.keys(registry)).toEqual([base.midnightUuid])
    expect(registry[base.midnightUuid]?.name).toBe('Pnyx')
  })

  it('installs the identity’s named keys alongside the UUID slot', () => {
    const registry = install({name: 'Lace', keys: ['mnLace', 'lace']})
    expect(Object.keys(registry).sort()).toEqual([base.midnightUuid, 'lace', 'mnLace'].sort())
    // One wallet in three slots, not three wallets.
    expect(registry.mnLace).toBe(registry[base.midnightUuid])
  })

  it('reports the Midnight identity’s name, not the Cardano one', () => {
    expect(install({name: 'Lace', keys: ['mnLace']})[base.midnightUuid]?.name).toBe('Lace')
    expect(install({name: '1AM', keys: ['1am']})[base.midnightUuid]?.name).toBe('1AM')
  })

  it('keeps rdns honest — it names the software answering, whatever the identity', () => {
    expect(install({name: 'Lace', keys: ['mnLace']})[base.midnightUuid]?.rdns).toBe('uk.pxkq.pnyx')
  })

  // ⚠️ Asserting on the *resolved provider*, not on which slot won. Every slot holds the same
  // object and each one carries the identity's name, so the UUID slot satisfies the match first —
  // which is the point: the name alone is enough, and the named keys are the second chance for
  // dApps that index the registry directly instead of enumerating it.
  it("is found by a real dApp's Lace lookup", () => {
    const picked = ASCEND_PICK(install({name: 'Lace', keys: ['mnLace', 'lace']}), 'lace')
    expect(picked?.byName).toBe(true)
    expect(picked?.provider?.name).toBe('Lace')
  })

  it("is found by a real dApp's 1AM lookup", () => {
    const picked = ASCEND_PICK(install({name: '1AM', keys: ['1am']}), '1am')
    expect(picked?.byName).toBe(true)
    expect(picked?.provider?.name).toBe('1AM')
  })

  it('as Pnyx, a Lace lookup falls back rather than matching', () => {
    const picked = ASCEND_PICK(install({name: 'Pnyx', keys: ['pnyx']}), 'lace')
    // Still reachable — a dApp with one wallet present connects to it — but not because it believed
    // we were Lace. `byName: false` is the difference the setting actually controls.
    expect(picked?.byName).toBe(false)
    expect(picked?.provider?.name).toBe('Pnyx')
  })

  it('as Pnyx, is NOT matched by a Lace lookup', () => {
    // The fallback still returns us (a dApp with one wallet installed connects to it), but not via
    // the name match — which is the part the setting controls.
    const registry = install({name: 'Pnyx', keys: ['pnyx']})
    const entries = Object.entries(registry)
    const named = entries.find(([key, p]) => `${key} ${p?.name ?? ''}`.toLowerCase().includes('lace'))
    expect(named).toBeUndefined()
  })

  it('never overwrites a real extension that got to a slot first', () => {
    const fakeWindow: Record<string, unknown> = {
      ReactNativeWebView: {postMessage: () => {}},
      location: {origin: 'https://dapp.example'},
      addEventListener: () => {},
      dispatchEvent: () => true,
      midnight: {mnLace: {rdns: 'io.lace', name: 'Lace', connect: () => undefined}},
    }
    const script = generateInjectionScript({...base, midnightIdentity: {name: 'Lace', keys: ['mnLace']}})
    new Function('window', 'setTimeout', 'clearTimeout', script)(
      fakeWindow,
      () => 0,
      () => {},
    )
    const registry = fakeWindow.midnight as Record<string, Initial>
    expect(registry.mnLace?.rdns).toBe('io.lace')
  })
})
