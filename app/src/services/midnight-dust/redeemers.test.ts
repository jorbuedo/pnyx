import {describe, expect, it} from 'vitest'

import {BURN_REDEEMER_ALT, mintRedeemerAlt, REGISTER_REDEEMER_ALT} from './redeemers'

describe('mintRedeemerAlt', () => {
  it('registers under the unit constructor, which is the registration path', () => {
    expect(mintRedeemerAlt('mint')).toBe(REGISTER_REDEEMER_ALT)
    expect(REGISTER_REDEEMER_ALT).toBe(0n)
  })

  // The defect, reproduced from a mainnet rejection on 2026-08-29 and then from the real script: a burn
  // sent under the unit redeemer takes the mint handler's *registration* branch, whose first check is
  // `expect [Pair("", 1)]` — a mint of exactly one. A burn is -1 and fails it, so the node refuses the
  // whole transaction under MintingScript. The spend handler had passed; only this purpose did not.
  it('burns under a different constructor, because unit selects the branch that forbids a burn', () => {
    expect(mintRedeemerAlt('burn')).toBe(BURN_REDEEMER_ALT)
    expect(mintRedeemerAlt('burn')).not.toBe(REGISTER_REDEEMER_ALT)
  })
})
