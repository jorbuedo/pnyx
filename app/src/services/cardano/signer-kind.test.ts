import type {WalletSource} from '@pnyx/wallet'
import {describe, expect, it} from 'vitest'
import {signerKindOf, signsAlone} from './signer-kind'

const ALL_SOURCES: readonly WalletSource[] = ['mnemonic', 'hardware', 'read-only', 'imported-xpriv', 'multisig']

describe('signerKindOf', () => {
  it('maps the credential-holding sources', () => {
    expect(signerKindOf('mnemonic')).toBe('software')
    expect(signerKindOf('hardware')).toBe('hardware')
  })

  it('maps a shared wallet to script — it is spent by a policy, not a key', () => {
    expect(signerKindOf('multisig')).toBe('script')
  })

  it('answers null for a source it does not know rather than guessing', () => {
    // Failing closed is the point: an unrecognised source must not fall into the
    // key-signing path.
    expect(signerKindOf('read-only')).toBeNull()
    expect(signerKindOf(undefined)).toBeNull()
    expect(signerKindOf('something-new')).toBeNull()
  })

  it('has an answer for every member of WalletSource', () => {
    for (const source of ALL_SOURCES) expect(signerKindOf(source)).not.toBeUndefined()
  })
})

describe('signsAlone', () => {
  it('admits only the kinds that hold a credential', () => {
    expect(signsAlone('software')).toBe(true)
    expect(signsAlone('hardware')).toBe(true)
  })

  it('excludes script and null', () => {
    // A script wallet's signatures belong to other people, so there is nothing
    // synchronous for a ceremony to return.
    expect(signsAlone('script')).toBe(false)
    expect(signsAlone(null)).toBe(false)
  })

  it('excludes every source that cannot complete a transaction alone', () => {
    const cannot = ALL_SOURCES.filter((s) => !signsAlone(signerKindOf(s)))
    expect(cannot).toEqual(['read-only', 'imported-xpriv', 'multisig'])
  })
})
