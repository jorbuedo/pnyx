import {XpubHex} from '@evolution-sdk/review/Brands'
import {Address, Keys} from '@pnyx/cardano-core'
import {type CardanoGovKeys, deriveCardanoGovKeys} from '@pnyx/wallet'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import type {EnvelopeSigner} from '../cosign/types'
import {
  awaitingCoSigners,
  type LocalWalletKey,
  localCoSignersOf,
  localWalletForKey,
  outstandingLocalCoSigners,
  strandedByRemoving,
} from './local-cosigners'
import {deriveOwnAccountXpub} from './model'
import {flatTemplate, tagAt} from './template'
import type {CoSignerRef, SharedWallet} from './types'

const MNEMONIC_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const MNEMONIC_B = 'test walk nut penalty hip pave soap entry language right filter choice'

const run = <A>(eff: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

let XPUB_A = ''
let XPUB_B = ''
let GOV_A: CardanoGovKeys

beforeAll(async () => {
  XPUB_A = await run(Keys.rootKeyFromMnemonic(MNEMONIC_A).pipe(Effect.flatMap((r) => deriveOwnAccountXpub(r, 0))))
  XPUB_B = await run(Keys.rootKeyFromMnemonic(MNEMONIC_B).pipe(Effect.flatMap((r) => deriveOwnAccountXpub(r, 0))))
  GOV_A = await run(deriveCardanoGovKeys(MNEMONIC_A))
})

describe('the cached CIP-1854 xpub', () => {
  it('is the same key the roster names, derived two independent ways', async () => {
    // The whole matcher rests on this. `deriveCardanoGovKeys` derives it beside
    // the CIP-1852 keys so it can be cached; `deriveOwnAccountXpub` is what the
    // roster editor used to build the roster. If they ever disagree, every wallet
    // silently stops recognising itself as a co-signer.
    expect(GOV_A.sharedAccountXpubHex).toBe(XPUB_A)
  })

  it('is not the CIP-1852 account xpub, which is a different key entirely', () => {
    // Same seed, same account index, different purpose. Handing this one to the
    // hardware device-identity check would compare the wrong key.
    expect(GOV_A.sharedAccountXpubHex).not.toBe(GOV_A.accountXpubHex)
  })
})

const wallet = (over: Partial<SharedWallet> = {}): SharedWallet => {
  const coSigners: CoSignerRef[] = [
    {tag: tagAt(0), name: 'Alice', accountXpubHex: XpubHex(XPUB_A), isSelf: true},
    {tag: tagAt(1), name: 'Bob', accountXpubHex: XpubHex(XPUB_B)},
  ]
  const template = flatTemplate({kind: 'all'}, [tagAt(0), tagAt(1)])
  return {
    id: 'w1',
    name: 'Duo',
    coSigners,
    paymentTemplate: template,
    delegationTemplate: template,
    network: Address.Network.Testnet,
    accountIndex: 0,
    selfGroupId: 'group-alice',
    createdAt: '2026-08-10T00:00:00.000Z',
    ...over,
  }
}

const local = (groupId: string, name: string, xpub?: string): LocalWalletKey => ({
  groupId,
  name,
  source: 'mnemonic',
  govKeys: xpub === undefined ? null : ({...GOV_A, sharedAccountXpubHex: xpub} as CardanoGovKeys),
})

/** Two scripts (payment + stake), so each co-signer owes two witnesses. */
const rows = (signed: {readonly alice?: number; readonly bob?: number} = {}): readonly EnvelopeSigner[] => {
  const a = signed.alice ?? 0
  const b = signed.bob ?? 0
  return [
    {id: tagAt(0), name: 'Alice', keyHashHex: 'aa', signed: a > 0},
    {id: tagAt(1), name: 'Bob', keyHashHex: 'bb', signed: b > 0},
    {id: tagAt(0), name: 'Alice', keyHashHex: 'a1', signed: a > 1, scriptIndex: 1},
    {id: tagAt(1), name: 'Bob', keyHashHex: 'b1', signed: b > 1, scriptIndex: 1},
  ]
}

describe('localCoSignersOf', () => {
  it('offers every co-signer this device holds a key for, not just the first', () => {
    // The point of the whole change: a device holding two of a wallet's keys used
    // to be able to contribute only the one marked `isSelf`.
    const found = localCoSignersOf(wallet(), [
      local('group-alice', 'My wallet', XPUB_A),
      local('group-bob', 'Second', XPUB_B),
    ])
    expect(found.map((c) => c.tag)).toEqual([tagAt(0), tagAt(1)])
    expect(found.map((c) => c.groupId)).toEqual(['group-alice', 'group-bob'])
  })

  it('offers none of a roster made entirely of other people keys', () => {
    // A wallet we can watch and never witness for. An empty list says exactly
    // that, and the screen can then offer submit and export and nothing else.
    const {selfGroupId: _none, ...watched} = wallet()
    expect(localCoSignersOf(watched, [local('group-x', 'Mine', 'ff'.repeat(64))])).toEqual([])
  })

  it('falls back to selfGroupId for a wallet whose xpub was never cached', () => {
    // Every wallet created before the xpub joined the gov-keys record. Without
    // this they would stop being able to sign their own wallets until something
    // happened to re-derive.
    const found = localCoSignersOf(wallet(), [local('group-alice', 'My wallet')])
    expect(found.map((c) => c.tag)).toEqual([tagAt(0)])
  })

  it('prefers the cached xpub over selfGroupId when they disagree', () => {
    // Evidence beats a record of intent: a wallet removed and restored comes back
    // under a new group id, and `selfGroupId` then points at nothing real.
    const found = localCoSignersOf(wallet({selfGroupId: 'group-gone'}), [local('group-new', 'Restored', XPUB_A)])
    expect(found).toHaveLength(1)
    expect(found[0]?.groupId).toBe('group-new')
  })

  it('matches an xpub whatever case it was stored in', () => {
    const found = localCoSignersOf(wallet(), [local('group-alice', 'Mine', XPUB_A.toUpperCase())])
    expect(found).toHaveLength(1)
  })

  it('counts signatures per script rather than as a tick', () => {
    // A co-signer owes one witness per script — the spend and the delegation. A
    // boolean would read "signed" for someone who signed one and not the other.
    const found = localCoSignersOf(wallet(), [local('group-alice', 'Mine', XPUB_A)], rows({alice: 1}))
    expect(found[0]).toMatchObject({signed: 1, required: 2})
  })
})

describe('outstandingLocalCoSigners', () => {
  it('drops a co-signer who has signed everything they owe', () => {
    const all = localCoSignersOf(wallet(), [local('group-alice', 'Mine', XPUB_A)], rows({alice: 2}))
    expect(outstandingLocalCoSigners(all, false)).toEqual([])
  })

  it('keeps one who has signed only some of their scripts', () => {
    const all = localCoSignersOf(wallet(), [local('group-alice', 'Mine', XPUB_A)], rows({alice: 1}))
    expect(outstandingLocalCoSigners(all, false)).toHaveLength(1)
  })

  it('offers nobody once the transaction meets its quorum', () => {
    // The 1-of-2 case. Alice has signed, so the wallet is submittable; Bob's row
    // still owes a witness and read as outstanding, which auto-opened a review to
    // sign as him for a transaction that needed nothing more. A witness past
    // quorum is also unpaid-for bytes — the fee budgets a quorum's worth.
    const all = localCoSignersOf(
      wallet(),
      [local('group-alice', 'Mine', XPUB_A), local('group-bob', 'Also mine', XPUB_B)],
      rows({alice: 2}),
    )
    expect(all.some((c) => c.signed < c.required)).toBe(true)
    expect(outstandingLocalCoSigners(all, true)).toEqual([])
  })
})

describe('awaitingCoSigners', () => {
  it('names the people we cannot sign for and who have not signed', () => {
    const mine = localCoSignersOf(wallet(), [local('group-alice', 'Mine', XPUB_A)], rows({alice: 2}))
    expect(awaitingCoSigners(wallet(), mine, rows({alice: 2}))).toEqual(['Bob'])
  })

  it('names nobody once everyone else has signed', () => {
    const mine = localCoSignersOf(wallet(), [local('group-alice', 'Mine', XPUB_A)], rows({alice: 2, bob: 2}))
    expect(awaitingCoSigners(wallet(), mine, rows({alice: 2, bob: 2}))).toEqual([])
  })

  it('does not name someone whose signature we could give ourselves', () => {
    const mine = localCoSignersOf(wallet(), [local('group-alice', 'A', XPUB_A), local('group-bob', 'B', XPUB_B)])
    expect(awaitingCoSigners(wallet(), mine, rows())).toEqual([])
  })
})

describe('strandedByRemoving', () => {
  // A function, not a constant: a describe body runs at collection time, before
  // `beforeAll` has derived the xpubs, so a constant here would hold two empty
  // strings and match nothing.
  const both = () => [local('group-alice', 'A', XPUB_A), local('group-bob', 'B', XPUB_B)]

  it('names a shared wallet losing its last local key', () => {
    // The accident the guard exists for: the wallet stays listed, keeps whatever
    // is at its address, and can never spend again.
    expect(strandedByRemoving('group-alice', [wallet()], [local('group-alice', 'A', XPUB_A)])).toEqual([
      {id: 'w1', name: 'Duo'},
    ])
  })

  it('says nothing while another local key still backs it', () => {
    expect(strandedByRemoving('group-alice', [wallet()], both())).toEqual([])
  })

  it('says nothing about a wallet that was already watch-only', () => {
    // Imported as a roster of other people's keys. Not stranded by this removal —
    // it never could sign here, and that is a state we support.
    const {selfGroupId: _none, ...watched} = wallet()
    expect(strandedByRemoving('group-x', [watched], [local('group-x', 'Mine', 'ff'.repeat(64))])).toEqual([])
  })

  it('names every wallet the removal would strand, not just the first', () => {
    const second = {...wallet(), id: 'w2', name: 'Council'}
    const stranded = strandedByRemoving('group-alice', [wallet(), second], [local('group-alice', 'A', XPUB_A)])
    expect(stranded.map((w) => w.name)).toEqual(['Duo', 'Council'])
  })

  it('says nothing when the wallet being removed backs none of them', () => {
    expect(strandedByRemoving('group-unrelated', [wallet()], both())).toEqual([])
  })
})

describe('localWalletForKey', () => {
  const KEY = 'a'.repeat(128)
  const OTHER = 'b'.repeat(128)
  const local = (groupId: string, shared?: string): LocalWalletKey => ({
    groupId,
    name: groupId,
    source: 'mnemonic',
    govKeys: shared === undefined ? null : ({accountXpubHex: 'x' as XpubHex, sharedAccountXpubHex: shared} as never),
  })

  it('finds the wallet whose cached key this is, whatever the case', () => {
    const found = localWalletForKey(KEY.toUpperCase(), [local('a', OTHER), local('b', KEY)])
    expect(found?.groupId).toBe('b')
  })

  it('is null for a key none of our wallets holds', () => {
    expect(localWalletForKey('c'.repeat(128), [local('a', OTHER), local('b', KEY)])).toBeNull()
  })

  it('ignores a wallet with no cached key rather than matching undefined', () => {
    expect(localWalletForKey(KEY, [local('a')])).toBeNull()
  })
})
