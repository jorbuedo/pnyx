import {describe, expect, it} from 'vitest'
import {ledgerSigningModeFor} from './signing-mode'

const base = {
  hasWitnessHash: false,
  hasCollateralInputs: false,
  hasRequiredSigners: false,
  signingPathCount: 1,
}

describe('ledgerSigningModeFor', () => {
  it('takes the caller at their word for a co-signer share', () => {
    // The two inference tests below both miss a CIP-1854 spend: one signing path,
    // and the keys named by the script rather than by `required_signers`.
    expect(ledgerSigningModeFor({...base, multisig: true})).toBe('multisig_transaction')
  })

  it('does not let a Plutus feature talk a declared multisig spend down', () => {
    expect(ledgerSigningModeFor({...base, multisig: true, hasWitnessHash: true})).toBe('multisig_transaction')
    expect(ledgerSigningModeFor({...base, multisig: true, hasCollateralInputs: true})).toBe('multisig_transaction')
  })

  it('still reads Plutus features as Plutus when nothing was declared', () => {
    expect(ledgerSigningModeFor({...base, hasWitnessHash: true})).toBe('plutus_transaction')
    expect(ledgerSigningModeFor({...base, hasCollateralInputs: true})).toBe('plutus_transaction')
  })

  it('keeps the old inference for a body that does say who must sign', () => {
    expect(ledgerSigningModeFor({...base, hasRequiredSigners: true, signingPathCount: 2})).toBe('multisig_transaction')
  })

  it('needs both halves of that inference, not either', () => {
    expect(ledgerSigningModeFor({...base, hasRequiredSigners: true, signingPathCount: 1})).toBe('ordinary_transaction')
    expect(ledgerSigningModeFor({...base, signingPathCount: 2})).toBe('ordinary_transaction')
  })

  it('leaves an ordinary transaction ordinary', () => {
    expect(ledgerSigningModeFor(base)).toBe('ordinary_transaction')
    expect(ledgerSigningModeFor({...base, multisig: false})).toBe('ordinary_transaction')
  })
})
