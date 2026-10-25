import {describe, expect, it} from 'vitest'
import {type DestinationChoice, describeDestination} from './destination'

const SELF = 'aa'.repeat(33)
const OTHER_WALLET = 'bb'.repeat(33)
const PNYX = 'cc'.repeat(33)
const STRANGER = 'dd'.repeat(33)

const choices: readonly DestinationChoice[] = [
  {payload: SELF, address: 'mn_dust1self', owner: {kind: 'self'}},
  {payload: OTHER_WALLET, address: 'mn_dust1other', owner: {kind: 'ownWallet', walletName: 'Savings'}},
  {payload: PNYX, address: 'mn_dust1pnyx', owner: {kind: 'pnyx'}},
]

describe('describeDestination', () => {
  it('names this wallet', () => {
    expect(describeDestination(SELF, choices)).toEqual({kind: 'self'})
  })

  it('names another of the user’s wallets', () => {
    expect(describeDestination(OTHER_WALLET, choices)).toEqual({kind: 'ownWallet', walletName: 'Savings'})
  })

  it('names Pnyx', () => {
    expect(describeDestination(PNYX, choices)).toEqual({kind: 'pnyx'})
  })

  it('calls an unrecognised address external, not wrong', () => {
    // Designating someone else is the delegation hook, so this is a legitimate
    // configuration the wallet reports rather than flags.
    expect(describeDestination(STRANGER, choices)).toEqual({kind: 'external'})
  })

  it('distinguishes an unreadable destination from an unrecognised one', () => {
    // The first is our blind spot; the second is the user's deliberate choice. Collapsing
    // them would either hide a gap or accuse the user of a mistake.
    expect(describeDestination(undefined, choices)).toEqual({kind: 'unknown'})
  })

  it('matches case-insensitively', () => {
    expect(describeDestination(SELF.toUpperCase(), choices)).toEqual({kind: 'self'})
  })

  it('is external when nothing is known', () => {
    expect(describeDestination(SELF, [])).toEqual({kind: 'external'})
  })
})
