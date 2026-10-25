import type {WalletSource} from '@pnyx/wallet'
import {describe, expect, it} from 'vitest'
import {translations as en} from '../../../i18n/translations'
import {
  canCoSign,
  coSignerKeyAccessOf,
  coSignerKeyIsReady,
  coSignerKeySourceOf,
  ineligibleReasonKey,
  reasonKeyOf,
  spendingAuthorityOf,
} from './eligibility'

const ALL_SOURCES: readonly WalletSource[] = ['mnemonic', 'hardware', 'read-only', 'imported-xpriv', 'multisig']

describe('coSignerKeySourceOf', () => {
  it('derives from the seed for a mnemonic wallet', () => {
    expect(coSignerKeySourceOf('mnemonic')).toEqual({kind: 'seed'})
  })

  it('refuses imported-xpriv, because no xpriv vault slot backs it yet', () => {
    // deriveGroupCoSignerXpub reads the mnemonic slot; claiming 'seed' would
    // offer a button that fails at the vault. signerKindOf agrees: also null.
    expect(coSignerKeySourceOf('imported-xpriv')).toEqual({kind: 'unavailable', reason: 'no-xpriv-slot'})
  })

  it('needs the device for a hardware wallet', () => {
    expect(coSignerKeySourceOf('hardware')).toEqual({kind: 'device'})
  })

  it('refuses a watch-only wallet — it can never produce a witness', () => {
    expect(coSignerKeySourceOf('read-only')).toEqual({kind: 'unavailable', reason: 'watch-only'})
  })

  it('answers for every source in the union', () => {
    // The bug this module exists to prevent was a source falling through an
    // assumption. Every member must have an explicit answer.
    for (const source of ALL_SOURCES) expect(coSignerKeySourceOf(source)).toBeDefined()
  })
})

describe('canCoSign', () => {
  it('admits everything that holds signing material', () => {
    expect(canCoSign('mnemonic')).toBe(true)
    expect(canCoSign('hardware')).toBe(true)
  })

  it('excludes watch-only and imported-xpriv', () => {
    expect(canCoSign('read-only')).toBe(false)
    expect(canCoSign('imported-xpriv')).toBe(false)
  })
})

describe('coSignerKeyAccessOf', () => {
  it('serves a hardware wallet from the cache once its key has been read', () => {
    expect(coSignerKeyAccessOf('hardware', true)).toEqual({kind: 'cached'})
  })

  it('still needs the device when the key has never been read', () => {
    expect(coSignerKeyAccessOf('hardware', false)).toEqual({kind: 'device'})
  })

  it('leaves a mnemonic wallet on the seed path even with a cached key', () => {
    // Reading the cache would drop the biometric ceremony from a flow that has
    // always had one — a consent decision, not a storage one.
    expect(coSignerKeyAccessOf('mnemonic', true)).toEqual({kind: 'seed'})
  })

  it('never promotes a wallet that cannot co-sign at all', () => {
    for (const source of ['read-only', 'imported-xpriv', 'multisig'] as const) {
      expect(coSignerKeyAccessOf(source, true).kind).toBe('unavailable')
    }
  })

  it('is ready exactly when nothing has to be connected', () => {
    expect(coSignerKeyIsReady(coSignerKeyAccessOf('hardware', true))).toBe(true)
    expect(coSignerKeyIsReady(coSignerKeyAccessOf('hardware', false))).toBe(false)
    expect(coSignerKeyIsReady(coSignerKeyAccessOf('mnemonic', false))).toBe(true)
    expect(coSignerKeyIsReady(coSignerKeyAccessOf('read-only', true))).toBe(false)
  })
})

describe('spendingAuthorityOf', () => {
  it('is none for watch-only and key for everything that signs', () => {
    expect(spendingAuthorityOf('read-only')).toBe('none')
    expect(spendingAuthorityOf('mnemonic')).toBe('key')
    expect(spendingAuthorityOf('hardware')).toBe('key')
    expect(spendingAuthorityOf('imported-xpriv')).toBe('key')
  })
})

describe('ineligibleReasonKey', () => {
  it('gives a reason only for wallets that cannot participate', () => {
    expect(ineligibleReasonKey('mnemonic')).toBeNull()
    expect(ineligibleReasonKey('hardware')).toBeNull()
  })

  it('gives each ineligible source its own message', () => {
    // The bug: all three shared one key, so the picker told a shared wallet it
    // was watch-only. Distinct keys are the whole fix — assert they differ
    // rather than only that each is non-empty.
    const keys = (['read-only', 'multisig', 'imported-xpriv'] as const).map(ineligibleReasonKey)
    expect(keys).toEqual([
      'multisig.create.ineligibleReadOnly',
      'multisig.create.ineligibleShared',
      'multisig.create.ineligibleImportedXpriv',
    ])
    expect(new Set(keys).size).toBe(3)
  })

  it('names a string that exists in the catalogue', () => {
    // A key typed as TranslationKey still has to resolve — the type is over the
    // EN source, and a renamed string would compile and render the key itself.
    for (const source of ALL_SOURCES) {
      const key = ineligibleReasonKey(source)
      if (key === null) continue
      const value = key.split('.').reduce<unknown>((node, part) => (node as Record<string, unknown>)?.[part], en)
      expect(typeof value).toBe('string')
    }
  })
})

describe('a shared wallet as a participant', () => {
  it('is spent by a script, not a key', () => {
    expect(spendingAuthorityOf('multisig')).toBe('script')
  })

  it('cannot itself be a co-signer', () => {
    // It holds no key to contribute; nesting one inside another is a template
    // question, not an xpub the picker can hand over.
    expect(canCoSign('multisig')).toBe(false)
    expect(coSignerKeySourceOf('multisig')).toEqual({kind: 'unavailable', reason: 'is-script'})
  })

  it('is told it is a script, not that it is watch-only', () => {
    expect(reasonKeyOf('is-script')).toBe('multisig.create.ineligibleShared')
  })
})
