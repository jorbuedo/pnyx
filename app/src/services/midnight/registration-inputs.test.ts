import {describe, expect, it} from 'vitest'

import {MAX_REGISTRATION_INPUTS, registrationInputs} from './registration-inputs'
import type {UnshieldedUtxo} from './wallet/unshielded-utxo-set'
import {NIGHT_TOKEN_TYPE} from './wallet/unshielded-utxo-set'

const utxo = (over: Partial<UnshieldedUtxo> & {value: bigint}): UnshieldedUtxo => ({
  owner: 'mn_addr_preprod1owner',
  tokenType: NIGHT_TOKEN_TYPE,
  intentHash: `${over.value}`.padStart(64, '0'),
  outputIndex: 0,
  ctime: 1_700_000_000,
  registeredForDustGeneration: false,
  ...over,
})

describe('registrationInputs', () => {
  it('takes the largest NIGHT first', () => {
    const picked = registrationInputs([utxo({value: 10n}), utxo({value: 500n}), utxo({value: 70n})])
    expect(picked.map((u) => u.value)).toEqual([500n, 70n, 10n])
  })

  // Each guaranteed NIGHT input costs ~2.4 ms of the 15 ms time-to-dismiss budget. A fifth does not
  // make the registration bigger, it makes it rejected — so the cap is a correctness bound, not a tidy-up.
  it('never offers more than the guaranteed segment can carry', () => {
    const many = Array.from({length: 12}, (_, i) => utxo({value: BigInt(i + 1)}))
    expect(registrationInputs(many)).toHaveLength(MAX_REGISTRATION_INPUTS)
    expect(registrationInputs(many).map((u) => u.value)).toEqual([12n, 11n, 10n, 9n])
  })

  // Already-generating NIGHT contributes zero to the ledger's availability sum, so including it would
  // spend one of four slots on nothing — and could make an otherwise-fundable registration fail.
  it('skips NIGHT that is already generating', () => {
    const picked = registrationInputs([utxo({value: 900n, registeredForDustGeneration: true}), utxo({value: 5n})])
    expect(picked.map((u) => u.value)).toEqual([5n])
  })

  it('ignores every other token', () => {
    const picked = registrationInputs([utxo({value: 900n, tokenType: 'aa'.repeat(32)}), utxo({value: 5n})])
    expect(picked.map((u) => u.value)).toEqual([5n])
  })

  it('reports an empty list rather than throwing when nothing is eligible', () => {
    expect(registrationInputs([])).toEqual([])
    expect(registrationInputs([utxo({value: 900n, registeredForDustGeneration: true})])).toEqual([])
  })

  it('does not reorder the caller’s array', () => {
    const utxos = [utxo({value: 10n}), utxo({value: 500n})]
    registrationInputs(utxos)
    expect(utxos.map((u) => u.value)).toEqual([10n, 500n])
  })
})
