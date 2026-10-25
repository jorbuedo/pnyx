import {hash160} from '@pnyx/crypto'
import {describe, expect, it} from 'vitest'

import {
  cardanoMultiAccounts,
  encodeCardanoAccountExport,
  masterFingerprintOf,
  requestedAccountsFrom,
} from './account-export'

const xpub = (fill: number) => new Uint8Array(64).fill(fill)
const name = ({accountIndex}: {accountIndex: number}) => `Cardano account ${accountIndex}`

/** Cardano's numbering, which the export must invert on the way out. */
const CARDANO_TESTNET = 0
const CARDANO_MAINNET = 1

describe('masterFingerprintOf', () => {
  it('is the first four bytes of hash160, big-endian', () => {
    const root = new Uint8Array(32).fill(7)
    const digest = hash160(root)
    const expected =
      (digest[0] ?? 0) * 0x1000000 + (digest[1] ?? 0) * 0x10000 + (digest[2] ?? 0) * 0x100 + (digest[3] ?? 0)
    expect(masterFingerprintOf(root)).toBe(expected)
  })

  // A leading byte ≥ 0x80 read as signed would encode as a CBOR negative integer, which is a
  // different value on the wire and unmatchable by the counterparty.
  it('stays unsigned when the leading byte has its high bit set', () => {
    // Search for a root whose digest starts high rather than asserting on a fixed one, so the
    // test does not depend on a particular hash output.
    for (let i = 0; i < 512; i++) {
      const root = new Uint8Array(32).fill(i % 256)
      if ((hash160(root)[0] ?? 0) < 0x80) continue
      expect(masterFingerprintOf(root)).toBeGreaterThan(0x7fffffff)
      return
    }
    throw new Error('no sample produced a high leading byte')
  })

  it('fits a uint32', () => {
    const value = masterFingerprintOf(new Uint8Array(32).fill(1))
    expect(Number.isInteger(value)).toBe(true)
    expect(value).toBeLessThanOrEqual(0xffffffff)
  })
})

describe('cardanoMultiAccounts', () => {
  it('splits the account xpub into key and chain code', () => {
    const source = new Uint8Array(64)
    source.set(new Uint8Array(32).fill(0xaa), 0)
    source.set(new Uint8Array(32).fill(0xbb), 32)
    const {keys} = cardanoMultiAccounts({
      masterFingerprint: 1,
      cardanoNetworkId: CARDANO_TESTNET,
      accounts: [{purpose: 1852, accountIndex: 0, xpub: source}],
      name,
    })
    expect(keys[0]?.keyData).toEqual(new Uint8Array(32).fill(0xaa))
    expect(keys[0]?.chainCode).toEqual(new Uint8Array(32).fill(0xbb))
  })

  it("publishes each account's own CIP-1852 path", () => {
    const {keys} = cardanoMultiAccounts({
      masterFingerprint: 1,
      cardanoNetworkId: CARDANO_TESTNET,
      accounts: [
        {purpose: 1852, accountIndex: 0, xpub: xpub(1)},
        {purpose: 1852, accountIndex: 3, xpub: xpub(2)},
      ],
      name,
    })
    expect(keys[0]?.origin.components).toEqual([
      {index: 1852, hardened: true},
      {index: 1815, hardened: true},
      {index: 0, hardened: true},
    ])
    expect(keys[1]?.origin.components[2]).toEqual({index: 3, hardened: true})
  })

  it('files every key under the master fingerprint', () => {
    const accounts = cardanoMultiAccounts({
      masterFingerprint: 0x1250b6bc,
      cardanoNetworkId: CARDANO_TESTNET,
      accounts: [
        {purpose: 1852, accountIndex: 0, xpub: xpub(1)},
        {purpose: 1852, accountIndex: 1, xpub: xpub(2)},
      ],
      name,
    })
    expect(accounts.masterFingerprint).toBe(0x1250b6bc)
    for (const key of accounts.keys) expect(key.origin.sourceFingerprint).toBe(0x1250b6bc)
  })

  it('takes the displayed name from the caller, so it can be translated', () => {
    const {keys} = cardanoMultiAccounts({
      masterFingerprint: 1,
      cardanoNetworkId: CARDANO_TESTNET,
      accounts: [{purpose: 1852, accountIndex: 2, xpub: xpub(1)}],
      name: ({accountIndex}) => `Konto ${accountIndex}`,
    })
    expect(keys[0]?.name).toBe('Konto 2')
  })

  // A short xpub would silently produce a 20-byte "chain code" and an export a counterparty
  // cannot derive addresses from — a failure that would only surface on someone else's device.
  it('refuses an xpub that is not 32 bytes of key plus 32 of chain code', () => {
    expect(() =>
      cardanoMultiAccounts({
        masterFingerprint: 1,
        cardanoNetworkId: CARDANO_TESTNET,
        accounts: [{purpose: 1852, accountIndex: 0, xpub: new Uint8Array(52)}],
        name,
      }),
    ).toThrow(/52 bytes/)
  })

  it('refuses to encode an empty export rather than emitting a QR with no keys', () => {
    expect(() =>
      encodeCardanoAccountExport(
        cardanoMultiAccounts({masterFingerprint: 1, cardanoNetworkId: CARDANO_TESTNET, accounts: [], name}),
      ),
    ).toThrow(/nothing to export/)
  })
})

/**
 * `use_info` is the only place an export says which network its xpubs are for. BCR-2020-007
 * numbers it the *inverse* of Cardano's own network id, so a pass-through would export every
 * mainnet account as testnet — a companion would then derive `addr_test1…` for real funds.
 */
describe('use_info (crypto-coin-info)', () => {
  const useInfoOf = (cardanoNetworkId: number) =>
    cardanoMultiAccounts({
      masterFingerprint: 1,
      cardanoNetworkId,
      accounts: [{purpose: 1852, accountIndex: 0, xpub: xpub(1)}],
      name,
    }).keys[0]?.useInfo

  it('states the Cardano coin type rather than leaning on the Bitcoin default', () => {
    expect(useInfoOf(CARDANO_TESTNET)?.type).toBe(1815)
  })

  it('inverts the network, because BCR numbers mainnet 0 and Cardano numbers it 1', () => {
    expect(useInfoOf(CARDANO_MAINNET)?.network).toBe(0)
    expect(useInfoOf(CARDANO_TESTNET)?.network).toBe(1)
  })

  it('reaches the encoded bytes as tag 305', () => {
    const bytes = encodeCardanoAccountExport(
      cardanoMultiAccounts({
        masterFingerprint: 1,
        cardanoNetworkId: CARDANO_MAINNET,
        accounts: [{purpose: 1852, accountIndex: 0, xpub: xpub(1)}],
        name,
      }),
    )
    // d9 0131 = tag 305, then a2 (2-entry map): 01 190717 (type 1815), 02 00 (network mainnet).
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
    expect(hex).toContain('d90131a2011907170200')
  })
})

const schema = (components: readonly {index: number; hardened: boolean}[], chainType?: string) => ({
  keyPath: {components},
  ...(chainType === undefined ? {} : {chainType}),
})
const hardened = (index: number) => ({index, hardened: true})

describe('requestedAccountsFrom', () => {
  /**
   * ⚠️ The assertion is ordered, and that is the point: 1854 comes back first because the call
   * asked for it first. A reader that assigns positionally — Eternl does — has no other way to
   * match our answer to its question, so "tidying" this into ascending purpose order is what
   * produces an import with the two chains swapped.
   */
  it("answers Eternl's two chains, in the order it asked", () => {
    const {accepted, declined} = requestedAccountsFrom({
      schemas: [
        schema([hardened(1854), hardened(1815), hardened(0)], 'ADA_CIP_1854'),
        schema([hardened(1852), hardened(1815), hardened(0)], 'ADA'),
      ],
    })
    expect(accepted).toEqual([
      {purpose: 1854, accountIndex: 0},
      {purpose: 1852, accountIndex: 0},
    ])
    expect(declined).toEqual([])
  })

  it('answers a higher account index', () => {
    const {accepted} = requestedAccountsFrom({schemas: [schema([hardened(1852), hardened(1815), hardened(3)])]})
    expect(accepted).toEqual([{purpose: 1852, accountIndex: 3}])
  })

  // Each of these would otherwise be "approximated" into a key nobody asked for — which surfaces
  // much later as a companion watching the wrong account.
  it('declines a path it cannot answer, by name', () => {
    const {accepted, declined} = requestedAccountsFrom({
      schemas: [
        schema([hardened(44), hardened(1815), hardened(0)]),
        schema([hardened(1852), hardened(60), hardened(0)]),
        schema([hardened(1852), hardened(1815), hardened(0), {index: 0, hardened: false}]),
        schema([hardened(1852), hardened(1815), {index: 0, hardened: false}]),
      ],
    })
    expect(accepted).toEqual([])
    expect(declined).toEqual([
      "m/44'/1815'/0': unsupported purpose",
      "m/1852'/60'/0': not Cardano",
      "m/1852'/1815'/0'/0: not an account-level path",
      "m/1852'/1815'/0: account-level components must be hardened",
    ])
  })

  it('publishes a repeated path once', () => {
    const {accepted} = requestedAccountsFrom({
      schemas: [
        schema([hardened(1852), hardened(1815), hardened(0)]),
        schema([hardened(1852), hardened(1815), hardened(0)]),
      ],
    })
    expect(accepted).toHaveLength(1)
  })

  it('keeps what it can answer when only some paths are declined', () => {
    const {accepted, declined} = requestedAccountsFrom({
      schemas: [
        schema([hardened(44), hardened(1815), hardened(0)]),
        schema([hardened(1852), hardened(1815), hardened(0)]),
      ],
    })
    expect(accepted).toEqual([{purpose: 1852, accountIndex: 0}])
    expect(declined).toHaveLength(1)
  })
})

describe('the multisig chain', () => {
  it('publishes each purpose under its own path', () => {
    const {keys} = cardanoMultiAccounts({
      masterFingerprint: 1,
      cardanoNetworkId: CARDANO_TESTNET,
      accounts: [
        {purpose: 1852, accountIndex: 0, xpub: xpub(1)},
        {purpose: 1854, accountIndex: 0, xpub: xpub(2)},
      ],
      name,
    })
    expect(keys.map((k) => k.origin.components[0])).toEqual([
      {index: 1852, hardened: true},
      {index: 1854, hardened: true},
    ])
  })

  /**
   * Eternl assigns keys by position and ignores `origin`, so the caller's order IS the wire order
   * and nothing here may quietly normalise it. Two runs on 2026-08-07 settled it: answering its
   * call in the order asked (1854, 1852) imported correctly; publishing 1852 first came back with
   * the chains swapped.
   *
   * Assert on key bytes and not only on paths — publishing correct paths against reordered keys is
   * precisely the failure this guards, and a path-only assertion sails straight through it.
   */
  it('preserves the caller’s order exactly, imposing none of its own', () => {
    const {keys} = cardanoMultiAccounts({
      masterFingerprint: 1,
      cardanoNetworkId: CARDANO_TESTNET,
      accounts: [
        {purpose: 1854, accountIndex: 0, xpub: xpub(0x54)},
        {purpose: 1852, accountIndex: 0, xpub: xpub(0x52)},
      ],
      name,
    })
    expect(keys.map((k) => k.origin.components[0]?.index)).toEqual([1854, 1852])
    expect(keys.map((k) => k.keyData[0])).toEqual([0x54, 0x52])
  })
})
