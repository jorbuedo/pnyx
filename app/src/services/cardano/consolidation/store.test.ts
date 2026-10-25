import {describe, expect, it} from 'vitest'
import {DEFAULT_WALLET_OPTIMIZATION} from './policy'
import {decodeWalletOptimization} from './store'

describe('decodeWalletOptimization', () => {
  it('returns the defaults for a non-object payload', () => {
    for (const payload of [null, undefined, 'true', 7, []]) {
      // An array is an object, so it decodes field-by-field into the defaults —
      // which is the same answer, reached honestly.
      expect(decodeWalletOptimization(payload)).toEqual(DEFAULT_WALLET_OPTIMIZATION)
    }
  })

  it('keeps the fields it recognises and defaults only the ones it does not', () => {
    // What a value written before a knob existed looks like: the knobs that were
    // stored must survive, and only the new one falls back.
    const decoded = decodeWalletOptimization({autoConsolidate: true, bundleByPolicy: false})

    expect(decoded.autoConsolidate).toBe(true)
    expect(decoded.bundleByPolicy).toBe(false)
    expect(decoded.keepPureAdaOutput).toBe(DEFAULT_WALLET_OPTIMIZATION.keepPureAdaOutput)
    expect(decoded.autoWithdrawRewards).toBe(DEFAULT_WALLET_OPTIMIZATION.autoWithdrawRewards)
  })

  it('ignores a wrong-typed flag rather than coercing it', () => {
    // `'false'` is truthy; coercing it would turn a corrupt value into an
    // enabled setting that spends the user's ADA on extra transactions.
    expect(decodeWalletOptimization({autoConsolidate: 'false'}).autoConsolidate).toBe(false)
    expect(decodeWalletOptimization({autoConsolidate: 1}).autoConsolidate).toBe(false)
  })

  it('keeps a positive integer input cap', () => {
    expect(decodeWalletOptimization({maxInputsPerTx: 40}).maxInputsPerTx).toBe(40)
  })

  it('drops a cap that is not a positive integer, rather than honouring nonsense', () => {
    // A cap of 0 would refuse to fold anything; a fractional cap would truncate
    // unpredictably. Absent means "the size bound alone decides".
    for (const cap of [0, -5, 1.5, Number.NaN, '40', null]) {
      expect(decodeWalletOptimization({maxInputsPerTx: cap}).maxInputsPerTx).toBeUndefined()
    }
  })
})
