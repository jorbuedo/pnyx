import {XpubHex} from '@evolution-sdk/review/Brands'
import {Address, Keys} from '@pnyx/cardano-core'
import {classifyCreds} from '@pnyx/tx-review'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {accountScriptContext, authorityPlanFields, authorityStakeContext} from '../account'
import {cardanoAccountFromSharedWallet} from './account'
import {paymentKeyHashAt, scriptsAt, stakeKeyHashOf} from './derive'
import {deriveOwnAccountXpub} from './model'
import type {ScriptTemplate} from './template'
import {flatTemplate, tagAt, withTimeLock} from './template'
import type {CoSignerRef, SharedWallet} from './types'

const MNEMONIC_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const MNEMONIC_B = 'test walk nut penalty hip pave soap entry language right filter choice'

const run = <A>(eff: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

const xpubOf = (mnemonic: string, account = 0) =>
  Keys.rootKeyFromMnemonic(mnemonic).pipe(Effect.flatMap((root) => deriveOwnAccountXpub(root, account)))

let A = ''
let B = ''
let C = ''

beforeAll(async () => {
  A = await run(xpubOf(MNEMONIC_A))
  B = await run(xpubOf(MNEMONIC_B))
  C = await run(xpubOf(MNEMONIC_B, 1))
})

const wallet = (
  over: {
    readonly selfAt?: number | null
    readonly template?: ScriptTemplate
    /** Defaults to the payment template, which is what the roster editor builds. */
    readonly delegationTemplate?: ScriptTemplate
  } = {},
): SharedWallet => {
  const selfAt = over.selfAt === undefined ? 0 : over.selfAt
  const coSigners: CoSignerRef[] = [A, B, C].map((xpub, i) => ({
    tag: tagAt(i),
    name: `C${i}`,
    accountXpubHex: XpubHex(xpub),
    ...(selfAt === i ? {isSelf: true as const} : {}),
  }))
  const t =
    over.template ??
    flatTemplate(
      {kind: 'atLeast', n: 2},
      coSigners.map((c) => c.tag),
    )
  return {
    id: 'w1',
    name: 'Treasury',
    coSigners,
    paymentTemplate: t,
    delegationTemplate: over.delegationTemplate ?? t,
    network: Address.Network.Testnet,
    accountIndex: 0,
    createdAt: '2026-08-09T00:00:00.000Z',
  }
}

/**
 * A shared wallet's stake credential is its delegation script, so it is always
 * present. Narrowed here rather than asserted at every use, and loudly, because a
 * `null` would mean the constructor stopped producing one.
 */
const stakeOf = (account: {readonly stakeKeyHashHex: string | null}): string => {
  if (account.stakeKeyHashHex === null) throw new Error('shared wallet account has no stake credential')
  return account.stakeKeyHashHex
}

const rewardOf = (account: {readonly rewardAddressBech32: string | null}): string => {
  if (account.rewardAddressBech32 === null) throw new Error('shared wallet account has no reward address')
  return account.rewardAddressBech32
}

describe('cardanoAccountFromSharedWallet', () => {
  it('presents a script authority carrying the compiled script', async () => {
    const account = await run(cardanoAccountFromSharedWallet(wallet(), 0))
    expect(account.authority.kind).toBe('script')
    expect(authorityPlanFields(account.authority).nativeScripts).toHaveLength(1)
  })

  it('names every co-signer leaf at the spending index', async () => {
    const account = await run(cardanoAccountFromSharedWallet(wallet(), 3))
    const expected = await Promise.all([A, B, C].map((x) => run(paymentKeyHashAt(XpubHex(x), 3))))
    expect([...(accountScriptContext(account)?.[0]?.signerKeyHashes ?? [])].sort()).toEqual([...expected].sort())
  })

  it('names different leaves at a different index — the index is load-bearing', async () => {
    const [at0, at1] = await Promise.all([
      run(cardanoAccountFromSharedWallet(wallet(), 0)),
      run(cardanoAccountFromSharedWallet(wallet(), 1)),
    ])
    expect(accountScriptContext(at0)?.[0]?.signerKeyHashes).not.toEqual(accountScriptContext(at1)?.[0]?.signerKeyHashes)
    expect(at0.addressBech32).not.toBe(at1.addressBech32)
  })

  it('budgets the quorum, not one witness', async () => {
    const account = await run(cardanoAccountFromSharedWallet(wallet(), 0))
    expect(authorityPlanFields(account.authority).extraSigners).toBe(1) // 2-of-3, one already assumed
  })

  it('registers only our own key, at the CIP-1854 path for that index', async () => {
    const account = await run(cardanoAccountFromSharedWallet(wallet({selfAt: 1}), 5))
    const payment = account.keyRegistry.filter((k) => k.path.includes("'/0/"))
    expect(payment).toHaveLength(1)
    expect(payment[0]?.path).toBe("m/1854'/1815'/0'/0/5")
    expect(payment[0]?.keyHashHex).toBe(await run(paymentKeyHashAt(XpubHex(B), 5)))
  })

  describe('the stake side', () => {
    it('carries the delegation script, its leaves and its quorum', async () => {
      const account = await run(cardanoAccountFromSharedWallet(wallet(), 0))
      const stake = authorityStakeContext(account.authority)
      const scripts = await run(scriptsAt(wallet(), 0))
      expect(stake?.nativeScriptHex).toBe(scripts.stakingScriptHex)
      expect(stake?.scriptHashHex).toBe(scripts.stakingScriptHashHex)
      expect(stake?.requiredSigners).toBe(2)
      expect([...(stake?.signerKeyHashes ?? [])].sort()).toEqual(
        (await Promise.all([A, B, C].map((x) => run(stakeKeyHashOf(XpubHex(x)))))).sort(),
      )
    })

    it('reads the delegation template, not the payment one', async () => {
      // The two are the same for every wallet the roster editor builds, so a stake
      // authority compiled from `paymentTemplate` would pass every other test here
      // and delegate under the wrong policy for an imported wallet.
      const w = wallet({delegationTemplate: flatTemplate({kind: 'all'}, [tagAt(0), tagAt(1), tagAt(2)])})
      const account = await run(cardanoAccountFromSharedWallet(w, 0))
      expect(authorityStakeContext(account.authority)?.requiredSigners).toBe(3)
      // The payment side is untouched by it.
      expect(authorityPlanFields(account.authority).extraSigners).toBe(1)
    })

    it('does not vary with the spending index — one account, one reward address', async () => {
      const [at0, at7] = await Promise.all([
        run(cardanoAccountFromSharedWallet(wallet(), 0)),
        run(cardanoAccountFromSharedWallet(wallet(), 7)),
      ])
      expect(authorityStakeContext(at7.authority)).toEqual(authorityStakeContext(at0.authority))
      expect(at7.rewardAddressBech32).toBe(at0.rewardAddressBech32)
    })

    it('registers our stake key, so a delegation can be witnessed at all', async () => {
      // Without this entry `resolveCardanoSigningPaths` matches nothing for the
      // delegation script and the ceremony produces a transaction missing the one
      // witness that makes it a delegation — silently, since nothing asks.
      const account = await run(cardanoAccountFromSharedWallet(wallet({selfAt: 1}), 5))
      const stakeKey = account.keyRegistry.find((k) => k.path === "m/1854'/1815'/0'/2/0")
      expect(stakeKey?.keyHashHex).toBe(await run(stakeKeyHashOf(XpubHex(B))))
    })

    it('keeps the delegation script out of an ordinary spend', async () => {
      // The ledger rejects a native script nothing in the transaction needs
      // (ExtraneousScriptWitnessesUTXOW), so a send must carry payment scripts only.
      const account = await run(cardanoAccountFromSharedWallet(wallet(), 0))
      const scripts = await run(scriptsAt(wallet(), 0))
      expect(authorityPlanFields(account.authority).nativeScripts).not.toContain(scripts.stakingScriptHex)
    })
  })

  describe('several payment indexes', () => {
    it('carries a script per index, spending index first', async () => {
      const account = await run(cardanoAccountFromSharedWallet(wallet(), 0, [3]))
      const contexts = accountScriptContext(account) ?? []
      expect(contexts).toHaveLength(2)
      expect(authorityPlanFields(account.authority).nativeScripts).toHaveLength(2)
      if (account.authority.kind === 'script') {
        expect(account.authority.indexes.map((i) => i.keyIndex)).toEqual([0, 3])
      }
    })

    it('registers our own key at every index, so no witness goes missing', async () => {
      // The bug this shape prevents: a registry holding only the spending index's
      // key resolves one signing path, and the transaction goes out authorising
      // half its inputs — accepted by nothing, explained by nothing.
      const account = await run(cardanoAccountFromSharedWallet(wallet({selfAt: 1}), 0, [3]))
      expect(account.keyRegistry.map((k) => k.path)).toEqual([
        "m/1854'/1815'/0'/0/0",
        "m/1854'/1815'/0'/0/3",
        "m/1854'/1815'/0'/2/0",
      ])
      expect(account.keyRegistry[0]?.keyHashHex).toBe(await run(paymentKeyHashAt(XpubHex(B), 0)))
      expect(account.keyRegistry[1]?.keyHashHex).toBe(await run(paymentKeyHashAt(XpubHex(B), 3)))
    })

    it('pairs each index script hash with the leaves of that same index', async () => {
      const account = await run(cardanoAccountFromSharedWallet(wallet(), 0, [3]))
      const [first, second] = accountScriptContext(account) ?? []
      const at0 = await Promise.all([A, B, C].map((x) => run(paymentKeyHashAt(XpubHex(x), 0))))
      const at3 = await Promise.all([A, B, C].map((x) => run(paymentKeyHashAt(XpubHex(x), 3))))
      expect([...(first?.signerKeyHashes ?? [])].sort()).toEqual([...at0].sort())
      expect([...(second?.signerKeyHashes ?? [])].sort()).toEqual([...at3].sort())
      expect(first?.scriptHashHex).not.toBe(second?.scriptHashHex)
    })

    it('ignores a duplicate of the spending index and sorts the rest', async () => {
      const account = await run(cardanoAccountFromSharedWallet(wallet(), 2, [5, 2, 1]))
      if (account.authority.kind !== 'script') throw new Error('expected a script authority')
      expect(account.authority.indexes.map((i) => i.keyIndex)).toEqual([2, 1, 5])
    })

    it('budgets a quorum per index', async () => {
      // 2-of-3 at two indexes is four witnesses; one is already assumed.
      const account = await run(cardanoAccountFromSharedWallet(wallet(), 0, [3]))
      expect(authorityPlanFields(account.authority).extraSigners).toBe(3)
    })
  })

  it('registers no key when the roster does not include us', async () => {
    // A wallet we can watch but never witness for. An empty registry says so;
    // inventing a path would produce a witness nothing accepts.
    const account = await run(cardanoAccountFromSharedWallet(wallet({selfAt: null}), 0))
    expect(account.keyRegistry).toEqual([])
  })

  it('uses the script reward encoding, not the key one', async () => {
    const account = await run(cardanoAccountFromSharedWallet(wallet(), 0))
    expect(rewardOf(account).startsWith('stake_test1')).toBe(true)
    // A key-credential reward address would encode the same 28 bytes under a
    // different header, so compare against the script encoding explicitly.
    const scriptReward = Address.rewardScriptHex(Address.Network.Testnet, stakeOf(account))
    expect(account.rewardAddressHex).toBe(scriptReward)
  })

  it('sends change back to the same script address', async () => {
    // Change must stay under the same policy; paying it to a key address would
    // quietly move funds out of the shared wallet.
    const account = await run(cardanoAccountFromSharedWallet(wallet(), 2))
    expect(Address.toBech32Sync(account.addressHex)).toBe(account.addressBech32)
  })

  it('carries the template time locks into the plan', async () => {
    const locked = withTimeLock(flatTemplate({kind: 'all'}, [tagAt(0), tagAt(1), tagAt(2)]), {until: 4_000n})
    const account = await run(cardanoAccountFromSharedWallet(wallet({template: locked}), 0))
    expect(authorityPlanFields(account.authority).ttl).toBe(4000)
  })

  // Through `classifyCreds` rather than by inspecting the set: the previous
  // version of this test asserted the credential sat in `paymentKeyHashes`, which
  // was true and meant nothing — that reader skips script credentials entirely,
  // so review read the wallet's own address as a stranger's the whole time.
  it('makes review read the wallet own address as ours, not a stranger', async () => {
    const account = await run(cardanoAccountFromSharedWallet(wallet(), 0))
    const ownership = classifyCreds(
      account.walletContext,
      {hashHex: account.paymentKeyHashHex, isScript: true},
      {hashHex: stakeOf(account), isScript: true},
    )
    expect(ownership).toEqual({level: 'own', owner: 'wallet'})
  })

  it('reads another payment index of the same wallet as ours too', async () => {
    // A spend across indexes pays change to one of them. Without the other index
    // in the own-set it reads as sending that money to a counterparty.
    const other = await run(cardanoAccountFromSharedWallet(wallet(), 3))
    const account = await run(cardanoAccountFromSharedWallet(wallet(), 0, [3]))
    const ownership = classifyCreds(
      account.walletContext,
      {hashHex: other.paymentKeyHashHex, isScript: true},
      {hashHex: stakeOf(other), isScript: true},
    )
    expect(ownership).toEqual({level: 'own', owner: 'wallet'})
  })

  it('leaves a foreign script address as an escrow, not ours', async () => {
    // The widening must not turn every script address into the user's own. A
    // script over our stake credential that we hold no policy for is an escrow.
    const account = await run(cardanoAccountFromSharedWallet(wallet(), 0))
    const ownership = classifyCreds(
      account.walletContext,
      {hashHex: 'ff'.repeat(28), isScript: true},
      {hashHex: stakeOf(account), isScript: false},
    )
    expect(ownership.level).toBe('escrow')
  })
})
