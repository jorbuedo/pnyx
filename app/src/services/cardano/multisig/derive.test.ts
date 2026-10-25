import {KeyHashHex, type ScriptHex, type XpubHex} from '@evolution-sdk/review/Brands'
import {Address, Keys} from '@pnyx/cardano-core'
import {Effect, Exit} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {
  addressesUpTo,
  compileTemplate,
  ownPaymentPath,
  ownStakePath,
  paymentKeyHashAt,
  rewardAddressOf,
  scriptsAt,
  stakeKeyHashOf,
} from './derive'
import {flatTemplate, type ScriptTemplate, tagAt} from './template'
import {type CoSignerRef, MULTISIG_PAYMENT_ROLE, MULTISIG_STAKE_ROLE, type SharedWallet} from './types'

const HARDENED = 0x80000000
const ACCOUNT = 0

const MNEMONIC_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const MNEMONIC_B = 'test walk nut penalty hip pave soap entry language right filter choice'

const run = <A>(eff: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

/** The CIP-1854 account xpub (level 3) — what a co-signer actually shares. */
const accountXpub = (mnemonic: string) =>
  Effect.gen(function* () {
    const root = yield* Keys.rootKeyFromMnemonic(mnemonic)
    const acct = yield* Keys.derivePath(root, [
      (1854 | HARDENED) >>> 0,
      (1815 | HARDENED) >>> 0,
      (ACCOUNT | HARDENED) >>> 0,
    ])
    return yield* Keys.accountXpubOf(acct)
  })

/** The same key hash by the PRIVATE path, for the public-vs-private equality check. */
const privateKeyHash = (mnemonic: string, role: number, index: number) =>
  Effect.gen(function* () {
    const root = yield* Keys.rootKeyFromMnemonic(mnemonic)
    const child = yield* Keys.deriveCip1854(root, ACCOUNT, role, index)
    return yield* Keys.keyHashOf(child)
  })

let xpubA = '' as XpubHex
let xpubB = '' as XpubHex
let xpubC = '' as XpubHex

beforeAll(async () => {
  xpubA = await run(accountXpub(MNEMONIC_A))
  xpubB = await run(accountXpub(MNEMONIC_B))
  // A third distinct participant, from a non-zero account of the same seed.
  xpubC = await run(
    Effect.gen(function* () {
      const root = yield* Keys.rootKeyFromMnemonic(MNEMONIC_B)
      const acct = yield* Keys.derivePath(root, [
        (1854 | HARDENED) >>> 0,
        (1815 | HARDENED) >>> 0,
        (1 | HARDENED) >>> 0,
      ])
      return yield* Keys.accountXpubOf(acct)
    }),
  )
})

const roster = (): readonly CoSignerRef[] => [
  {tag: tagAt(0), name: 'Alice', accountXpubHex: xpubA, isSelf: true},
  {tag: tagAt(1), name: 'Bob', accountXpubHex: xpubB},
  {tag: tagAt(2), name: 'Carol', accountXpubHex: xpubC},
]

const wallet = (template?: ScriptTemplate): SharedWallet => {
  const coSigners = roster()
  const t =
    template ??
    flatTemplate(
      {kind: 'atLeast', n: 2},
      coSigners.map((c) => c.tag),
    )
  return {
    id: 'w1',
    name: 'Treasury',
    coSigners,
    paymentTemplate: t,
    delegationTemplate: t,
    network: Address.Network.Testnet,
    accountIndex: ACCOUNT,
    createdAt: '2026-08-08T00:00:00.000Z',
  }
}

describe('seedless derivation equals the private path', () => {
  it('payment key hash at index 0 matches deriveCip1854 role 0', async () => {
    const viaXpub = await run(paymentKeyHashAt(xpubA, 0))
    const viaSeed = await run(privateKeyHash(MNEMONIC_A, MULTISIG_PAYMENT_ROLE, 0))
    expect(viaXpub).toBe(viaSeed)
  })

  it('payment key hash at index 7 matches too — the index is not special-cased', async () => {
    const viaXpub = await run(paymentKeyHashAt(xpubB, 7))
    const viaSeed = await run(privateKeyHash(MNEMONIC_B, MULTISIG_PAYMENT_ROLE, 7))
    expect(viaXpub).toBe(viaSeed)
  })

  it('stake key hash matches deriveCip1854 role 2 index 0', async () => {
    const viaXpub = await run(stakeKeyHashOf(xpubA))
    const viaSeed = await run(privateKeyHash(MNEMONIC_A, MULTISIG_STAKE_ROLE, 0))
    expect(viaXpub).toBe(viaSeed)
  })
})

describe('scriptsAt', () => {
  it('derives a testnet script address and a script reward address', async () => {
    const s = await run(scriptsAt(wallet(), 0))
    expect(s.addressBech32.startsWith('addr_test1')).toBe(true)
    expect(s.rewardAddressBech32.startsWith('stake_test1')).toBe(true)
    expect(s.paymentScriptHashHex).toHaveLength(56)
    expect(s.stakingScriptHashHex).toHaveLength(56)
  })

  it('is deterministic — the same template and xpubs reproduce the same address', async () => {
    const [a, b] = await Promise.all([run(scriptsAt(wallet(), 3)), run(scriptsAt(wallet(), 3))])
    expect(a.addressBech32).toBe(b.addressBech32)
  })

  it('gives a different address per index', async () => {
    const [i0, i1] = await Promise.all([run(scriptsAt(wallet(), 0)), run(scriptsAt(wallet(), 1))])
    expect(i0.addressBech32).not.toBe(i1.addressBech32)
  })

  it('keeps one reward address across indexes — stake keys are pinned at 0', async () => {
    const [i0, i5] = await Promise.all([run(scriptsAt(wallet(), 0)), run(scriptsAt(wallet(), 5))])
    expect(i0.rewardAddressBech32).toBe(i5.rewardAddressBech32)
    expect(i0.stakingScriptHashHex).toBe(i5.stakingScriptHashHex)
  })

  it('a different quorum yields a different address at the same index', async () => {
    const tags = roster().map((c) => c.tag)
    const all = await run(scriptsAt(wallet(flatTemplate({kind: 'all'}, tags)), 0))
    const twoOf = await run(scriptsAt(wallet(flatTemplate({kind: 'atLeast', n: 2}, tags)), 0))
    expect(all.addressBech32).not.toBe(twoOf.addressBech32)
  })

  it('binds a co-signer by tag, not by array position', async () => {
    // Reordering the roster array leaves every tag bound to the same xpub, so the
    // compiled script — and the address — must not move.
    const base = wallet()
    const [first, second, third] = base.coSigners
    if (first === undefined || second === undefined || third === undefined) throw new Error('roster of 3 expected')
    const reordered: SharedWallet = {...base, coSigners: [second, first, third]}
    const [a, b] = await Promise.all([run(scriptsAt(base, 0)), run(scriptsAt(reordered, 0))])
    expect(a.addressBech32).toBe(b.addressBech32)
  })

  it('moves the address when a tag is rebound to a different xpub', async () => {
    // The converse of the above: what a tag *means* is load-bearing.
    const base = wallet()
    const [first, second, third] = base.coSigners
    if (first === undefined || second === undefined || third === undefined) throw new Error('roster of 3 expected')
    const swapped: SharedWallet = {
      ...base,
      coSigners: [
        {...first, accountXpubHex: second.accountXpubHex},
        {...second, accountXpubHex: first.accountXpubHex},
        third,
      ],
    }
    const [a, b] = await Promise.all([run(scriptsAt(base, 0)), run(scriptsAt(swapped, 0))])
    expect(a.addressBech32).not.toBe(b.addressBech32)
  })
})

describe('addressesUpTo', () => {
  it('returns indexes in order', async () => {
    const addrs = await run(addressesUpTo(wallet(), 3))
    expect(addrs.map((a) => a.index)).toEqual([0, 1, 2])
    expect(new Set(addrs.map((a) => a.addressBech32)).size).toBe(3)
  })

  it('returns nothing for a non-positive count', async () => {
    expect(await run(addressesUpTo(wallet(), 0))).toEqual([])
    expect(await run(addressesUpTo(wallet(), -3))).toEqual([])
  })
})

describe('rewardAddressOf', () => {
  it('agrees with the reward address scriptsAt reports', async () => {
    const [viaScripts, direct] = await Promise.all([run(scriptsAt(wallet(), 0)), run(rewardAddressOf(wallet()))])
    expect(direct).toBe(viaScripts.rewardAddressBech32)
  })
})

describe('compileTemplate', () => {
  it('fails loudly on a tag with no key hash rather than dropping the leaf', async () => {
    // Dropping it would silently turn a 2-of-3 into a 2-of-2.
    const t = flatTemplate({kind: 'atLeast', n: 2}, [tagAt(0), tagAt(1), tagAt(2)])
    const hashes = new Map([[tagAt(0), KeyHashHex('aa'.repeat(28))]])
    const exit = await Effect.runPromiseExit(compileTemplate(t, hashes) as Effect.Effect<ScriptHex>)
    expect(Exit.isFailure(exit)).toBe(true)
  })

  it('encodes time locks into the script', async () => {
    const withLock: ScriptTemplate = {
      kind: 'all',
      scripts: [
        {kind: 'cosigner', tag: tagAt(0)},
        {kind: 'invalidHereafter', slot: 1000n},
      ],
    }
    const plain = flatTemplate({kind: 'all'}, [tagAt(0)])
    const hashes = new Map([[tagAt(0), KeyHashHex('aa'.repeat(28))]])
    const [a, b] = await Promise.all([run(compileTemplate(withLock, hashes)), run(compileTemplate(plain, hashes))])
    expect(a).not.toBe(b)
  })
})

describe('signing paths', () => {
  it('builds CIP-1854 paths for the wallet account', () => {
    expect(ownPaymentPath(0, 0)).toBe("m/1854'/1815'/0'/0/0")
    expect(ownPaymentPath(2, 5)).toBe("m/1854'/1815'/2'/0/5")
    expect(ownStakePath(1)).toBe("m/1854'/1815'/1'/2/0")
  })
})
