import {describe, expect, it} from 'vitest'
import {translations as en} from '../../../i18n/translations'
import type {CoSignerXpubFailure} from '../../group-seed'
import {coSignerFailureKey, failureNeedsDevice} from './cosigner-key-message'

const ALL_FAILURES: readonly CoSignerXpubFailure[] = [
  {kind: 'no-key-material'},
  {kind: 'auth-cancelled'},
  {kind: 'key-invalidated'},
  {kind: 'vault-error', code: 'whatever'},
  {kind: 'derivation-failed'},
  {kind: 'device-key-missing'},
  {kind: 'ineligible', reason: 'watch-only'},
  {kind: 'ineligible', reason: 'is-script'},
  {kind: 'ineligible', reason: 'no-xpriv-slot'},
]

describe('coSignerFailureKey', () => {
  it('answers for every failure in the union', () => {
    for (const failure of ALL_FAILURES) expect(coSignerFailureKey(failure)).toBeTruthy()
  })

  it('names a string that exists in the catalogue', () => {
    // A key typed as TranslationKey still has to resolve — the type is over the
    // EN source, and a renamed string would compile and render the key itself.
    for (const failure of ALL_FAILURES) {
      const value = coSignerFailureKey(failure)
        .split('.')
        .reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en)
      expect(typeof value).toBe('string')
    }
  })

  it('keeps a device import distinct from a wallet that has no key at all', () => {
    // These were one message. "This wallet has no recovery phrase on this device"
    // is true of a hardware wallet and tells its owner nothing they can act on;
    // the key is on the device in their hand.
    expect(coSignerFailureKey({kind: 'device-key-missing'})).not.toBe(coSignerFailureKey({kind: 'no-key-material'}))
  })

  it('gives each ineligible reason its own message', () => {
    const keys = (['watch-only', 'is-script', 'no-xpriv-slot'] as const).map((reason) =>
      coSignerFailureKey({kind: 'ineligible', reason}),
    )
    expect(new Set(keys).size).toBe(3)
  })
})

describe('failureNeedsDevice', () => {
  it('is true only for the one failure a device connection clears', () => {
    for (const failure of ALL_FAILURES) {
      expect(failureNeedsDevice(failure)).toBe(failure.kind === 'device-key-missing')
    }
  })
})
