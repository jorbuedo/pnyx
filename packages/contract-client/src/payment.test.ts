import {readFileSync} from 'node:fs'
import {fileURLToPath} from 'node:url'
import {describe, expect, it} from 'vitest'

import {bytes32} from './bytes.js'
import {
  FREE_COLOR,
  moderatePermitDomain,
  pad32,
  permitDomain,
  permitPriceKey,
  persistentHash32,
  rebindPermitDomain,
} from './derivations.js'
import {encodeHandle} from './handle.js'
import {coinPublicKeyRecipient, createPaymentSimulator, userRecipient} from './payment-simulator.js'

const GRANT_SECRET = bytes32(0x5a)
const ADMIN_AUTH = persistentHash32([pad32('pnyx:admin'), GRANT_SECRET])
const TREASURY = userRecipient(bytes32(0x11))
const SHIELDED_TREASURY = coinPublicKeyRecipient(bytes32(0x12))
const BUYER = bytes32(0x22)
const USDM = bytes32(0x99)

const sim = (secret: Uint8Array = GRANT_SECRET) =>
  createPaymentSimulator({grantSecret: secret, nextAdminSecret: bytes32(0x66)}, TREASURY, SHIELDED_TREASURY, ADMIN_AUTH)

describe('setPrice — the circuit that keeps the currency out of frozen code', () => {
  it('adds a price, and the client derives the same key the circuit stored it under', () => {
    const s = sim()
    s.call('setPrice', 2n, USDM, 5_000_000n)
    const stored = [...s.getLedger().prices]
    expect(stored).toHaveLength(1)
    const [key, price] = stored[0] as [Uint8Array, bigint]
    expect(price).toBe(5_000_000n)
    // The parity that matters: a client deriving a different key reads a row that does not exist and
    // reports "currency not accepted" for one that is.
    expect(new Uint8Array(key)).toEqual(permitPriceKey(2, USDM))
  })

  it('keys each tier and each currency separately', () => {
    const s = sim()
    const other = bytes32(0x98)
    s.call('setPrice', 2n, USDM, 5n)
    s.call('setPrice', 3n, USDM, 6n)
    s.call('setPrice', 2n, other, 7n)
    expect([...s.getLedger().prices]).toHaveLength(3)
    expect(permitPriceKey(2, USDM)).not.toEqual(permitPriceKey(3, USDM))
    expect(permitPriceKey(2, USDM)).not.toEqual(permitPriceKey(2, other))
  })

  it('removes a currency when priced at zero — how one stops being accepted', () => {
    const s = sim()
    s.call('setPrice', 2n, USDM, 5n)
    s.call('setPrice', 2n, USDM, 0n)
    expect([...s.getLedger().prices]).toHaveLength(0)
    expect(() => s.call('setPrice', 2n, USDM, 0n)).toThrow(/no such price/)
  })

  it('refuses a caller who cannot derive adminAuth', () => {
    const s = sim(bytes32(0x01))
    expect(() => s.call('setPrice', 2n, USDM, 5n)).toThrow(/not authorised/)
  })
})

describe('grantPermit — what unblocks a handle claim without settling the currency', () => {
  it('mints a tier permit to a named recipient, gated on adminAuth', () => {
    const s = sim()
    // ⚠️ Naming a third party is only sound because the permit is UNSHIELDED. A contract-minted
    // *shielded* coin needs the recipient's encryption key, which this contract cannot carry — the reason the
    // shielded design had to mint to the caller and hand the grant over as an ordinary transfer.
    expect(() => s.call('grantPermit', 2n, userRecipient(BUYER))).not.toThrow()
  })

  it('refuses a caller who cannot derive adminAuth', () => {
    const s = sim(bytes32(0x01))
    expect(() => s.call('grantPermit', 2n, userRecipient(BUYER))).toThrow(/not authorised/)
  })

  it('needs no price row, which is what makes it exercise handles without a launch currency', () => {
    const s = sim()
    expect([...s.getLedger().prices]).toHaveLength(0)
    expect(() => s.call('grantPermit', 0n, userRecipient(BUYER))).not.toThrow()
  })
})

describe('grantRebindPermit', () => {
  it('is per name, and gated', () => {
    const s = sim()
    expect(() => s.call('grantRebindPermit', encodeHandle('alice'), userRecipient(BUYER))).not.toThrow()
    const other = sim(bytes32(0x01))
    expect(() => other.call('grantRebindPermit', encodeHandle('alice'), userRecipient(BUYER))).toThrow(/not authorised/)
  })
})

describe('buyPermitUnshielded', () => {
  it('refuses a currency with no price row for that tier', () => {
    const s = sim()
    s.call('setPrice', 2n, USDM, 5n)
    expect(() => s.call('buyPermitUnshielded', 3n, USDM, userRecipient(BUYER))).toThrow(
      /currency not accepted for this tier/,
    )
  })
})

describe('claimFreePermit — the path for a wallet with nothing in it', () => {
  it('mints a permit with no payment, once the admin opens the tier', () => {
    const s = sim()
    s.call('setPrice', 6n, FREE_COLOR, 1n)
    // No `receiveUnshielded` in this circuit at all: a brand-new identity holds no NIGHT, no USDM and
    // no DUST, and that is exactly who needs a name.
    expect(() => s.call('claimFreePermit', 6n, userRecipient(BUYER))).not.toThrow()
  })

  it('refuses a tier the admin has not opened, so free is a decision and not a default', () => {
    const s = sim()
    expect(() => s.call('claimFreePermit', 6n, userRecipient(BUYER))).toThrow(/not free/)
  })

  it('refuses a tier whose free row was closed again', () => {
    const s = sim()
    s.call('setPrice', 6n, FREE_COLOR, 1n)
    // Zero removes the row — the same lever that closes a currency ends a giveaway.
    s.call('setPrice', 6n, FREE_COLOR, 0n)
    expect(() => s.call('claimFreePermit', 6n, userRecipient(BUYER))).toThrow(/not free/)
  })

  it('keeps the tiers independent: a free t6 does not make t5 free', () => {
    const s = sim()
    s.call('setPrice', 6n, FREE_COLOR, 1n)
    expect(() => s.call('claimFreePermit', 5n, userRecipient(BUYER))).toThrow(/not free/)
  })

  // ⚠️ **Unbounded on purpose, and this is the assertion that says so.** An earlier version spent a
  // per-identity nullifier out of a `freeClaimed` set; it was deleted because this contract is deployed
  // once and can never be replaced, so anything accumulating here accumulates for the life of the
  // namespace — and it bought no Sybil resistance anyway, an identity being a seed. A free tier is a
  // long-name tier (t6 is 23–31 bytes), so squatting it costs the squatter and denies nobody.
  it('lets the same caller claim as often as the row is open, and stores nothing', () => {
    const s = sim()
    s.call('setPrice', 6n, FREE_COLOR, 1n)
    for (let i = 0; i < 3; i++) {
      expect(() => s.call('claimFreePermit', 6n, userRecipient(BUYER))).not.toThrow()
    }
  })

  it('grows no ledger structure — the contract still records nothing about a claim', () => {
    const s = sim()
    s.call('setPrice', 6n, FREE_COLOR, 1n)
    const before = [...s.getLedger().prices]
    s.call('claimFreePermit', 6n, userRecipient(BUYER))
    // `prices` is the only structure here, and a claim must not touch it: no row added, none removed.
    expect([...s.getLedger().prices]).toEqual(before)
  })
})

// The contract is read as text rather than imported: these are properties of the *source*, and the
// compiled binding cannot answer them. Same approach as `handle-contract-parity.test.ts`.
const CONTRACT = readFileSync(fileURLToPath(new URL('../../../contract/payment.compact', import.meta.url)), 'utf8')

describe('the contract keeps the shape the design depends on', () => {
  it('has no sweep — both purchase circuits forward in the circuit they receive in', () => {
    expect(CONTRACT).not.toMatch(/circuit sweep/)
    const pairs: readonly (readonly [string, string])[] = [
      ['receiveUnshielded', 'sendUnshielded'],
      ['receiveShielded', 'sendImmediateShielded'],
    ]
    for (const [receive, forward] of pairs) {
      expect(CONTRACT.indexOf(receive), receive).toBeGreaterThan(-1)
      expect(CONTRACT.indexOf(forward), forward).toBeGreaterThan(CONTRACT.indexOf(receive))
    }
  })

  it('mints the permit UNSHIELDED on both rails, because the frozen handle template spends one', () => {
    // `handle.compact`'s `bind` calls `receiveUnshielded(tokenType(domain, payment), 1)` and can never
    // change. So the permit's rail is fixed by that template, not by how the permit was paid for —
    // paying with a shielded coin still yields an unshielded permit.
    // Six mints now: four grants, two purchases… and the free claim, which mints on the same rail for
    // the same reason — the template that spends the permit is frozen, so the permit's rail is too.
    expect(CONTRACT.match(/mintUnshieldedToken/g)).toHaveLength(6)
    expect(CONTRACT).not.toMatch(/mintShieldedToken/)
  })

  it('seals a treasury for each rail, since the two address recipients with disjoint types', () => {
    expect(CONTRACT).toMatch(/sealed ledger treasury: Either<ContractAddress, UserAddress>/)
    expect(CONTRACT).toMatch(/sealed ledger shieldedTreasury: Either<ZswapCoinPublicKey, ContractAddress>/)
  })

  it('exposes exactly the eight entry points the deploy budget was measured against', () => {
    // A deploy's size is driven by the entry-point COUNT — one verifier key each, **exactly 2,119 bytes**
    // whatever the circuit does — so this list is a budget, not a style rule. Measured: ten entry points
    // land at 26,309 bytes and eleven are refused as `Transaction would exhaust the block limits`
    // (`contract/README.md`). `claimFreePermit` took this from seven to eight, and the fixture's initial
    // state grew by 2,190 bytes — 2,119 of it that one key.
    const exported = [...CONTRACT.matchAll(/export circuit (\w+)/g)].map((m) => m[1])
    expect(exported.sort()).toEqual(
      [
        'buyPermitShielded',
        'buyPermitUnshielded',
        'claimFreePermit',
        'grantModeratePermit',
        'grantPermit',
        'grantRebindPermit',
        'rotateAdmin',
        'setPrice',
      ].sort(),
    )
  })

  it('keeps adminAuth MUTABLE, which is the whole recovery path', () => {
    // Sealing it would put it in the address and make a leak permanent on the one contract that can
    // never be replaced. OpenZeppelin's `Ownable` keeps `_owner` mutable for the same reason.
    expect(CONTRACT).toMatch(/^export ledger adminAuth: Bytes<32>;$/m)
    expect(CONTRACT).not.toMatch(/sealed ledger adminAuth/)
  })
})

describe('rotateAdmin — why a leaked secret is recoverable', () => {
  const NEXT_SECRET = bytes32(0x77)

  it('hands authority to the next secret, and the old one stops working', () => {
    const s = createPaymentSimulator(
      {grantSecret: GRANT_SECRET, nextAdminSecret: NEXT_SECRET},
      TREASURY,
      SHIELDED_TREASURY,
      ADMIN_AUTH,
    )
    s.call('rotateAdmin')
    expect(new Uint8Array(s.getLedger().adminAuth)).toEqual(persistentHash32([pad32('pnyx:admin'), NEXT_SECRET]))

    // The old secret is now refused — the property a sealed field could never have offered.
    expect(() => s.call('setPrice', 2n, USDM, 5n)).toThrow(/not authorised/)

    s.setPrivateState({grantSecret: NEXT_SECRET, nextAdminSecret: NEXT_SECRET})
    expect(() => s.call('setPrice', 2n, USDM, 5n)).not.toThrow()
  })

  it('refuses a caller who cannot derive the CURRENT adminAuth', () => {
    const s = createPaymentSimulator(
      {grantSecret: bytes32(0x01), nextAdminSecret: NEXT_SECRET},
      TREASURY,
      SHIELDED_TREASURY,
      ADMIN_AUTH,
    )
    expect(() => s.call('rotateAdmin')).toThrow(/not authorised/)
  })
})

describe('grantModeratePermit — the handle template holds no authority of its own', () => {
  it('is gated on adminAuth like every other grant', () => {
    const s = sim()
    expect(() => s.call('grantModeratePermit', encodeHandle('alice'), userRecipient(BUYER))).not.toThrow()
  })

  it('refuses a caller who cannot derive adminAuth', () => {
    const s = sim(bytes32(0x01))
    expect(() => s.call('grantModeratePermit', encodeHandle('alice'), userRecipient(BUYER))).toThrow(/not authorised/)
  })

  it('is domain-separated from the rebind permit, or a transfer capability would moderate', () => {
    const name = encodeHandle('alice')
    expect(moderatePermitDomain(name)).not.toEqual(rebindPermitDomain(name))
    expect(CONTRACT).toContain('pad(32, "pnyx:moderate")')
  })
})

describe('the permit domains the handle template expects', () => {
  it('derives one colour domain per tier, matching the contract literals', () => {
    for (let tier = 0; tier <= 6; tier++) {
      expect(permitDomain(tier)).toEqual(pad32(`pnyx:permit:t${tier}`))
      expect(CONTRACT).toContain(`pad(32, "pnyx:permit:t${tier}")`)
    }
  })

  it('derives the rebind domain per name, matching the contract', () => {
    expect(rebindPermitDomain(encodeHandle('alice'))).toEqual(
      persistentHash32([pad32('pnyx:rebind'), encodeHandle('alice')]),
    )
    expect(CONTRACT).toContain('pad(32, "pnyx:rebind")')
  })
})
