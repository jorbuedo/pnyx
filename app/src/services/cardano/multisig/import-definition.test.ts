import {XpubHex} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {Either} from 'effect'
import {describe, expect, it} from 'vitest'
import type {SharedWalletDefinition} from './definition-link'
import {checkImport, definitionAsWallet, existingForDefinition, selfTagIn} from './import-definition'
import type {SharedWallet} from './types'

const KEY_A = 'a'.repeat(128)
const KEY_B = 'b'.repeat(128)
const KEY_C = 'c'.repeat(128)

const template = {
  kind: 'all' as const,
  scripts: [
    {kind: 'cosigner' as const, tag: 'cosigner#0'},
    {kind: 'cosigner' as const, tag: 'cosigner#1'},
  ],
}

const definition = (over: Partial<SharedWalletDefinition> = {}): SharedWalletDefinition => ({
  name: 'Rent pot',
  coSigners: [
    {tag: 'cosigner#0', name: 'Jordi', accountXpubHex: XpubHex(KEY_A)},
    {tag: 'cosigner#1', name: 'Alex', accountXpubHex: XpubHex(KEY_B)},
  ],
  paymentTemplate: template,
  delegationTemplate: template,
  network: Address.Network.Mainnet,
  accountIndex: 0,
  ...over,
})

const asWallet = (d: SharedWalletDefinition, over: Partial<SharedWallet> = {}): SharedWallet => ({
  ...definitionAsWallet(d, {id: 'local-1', createdAt: '2026-09-04T00:00:00.000Z'}),
  ...over,
})

describe('selfTagIn', () => {
  it('finds our row by xpub, whatever case it arrived in', () => {
    expect(selfTagIn(definition(), KEY_B.toUpperCase())?.tag).toBe('cosigner#1')
  })

  it('is null when our key is not in the roster', () => {
    expect(selfTagIn(definition(), KEY_C)).toBeNull()
  })

  it('never matches on a name — two participants can choose the same one', () => {
    const shared = definition({
      coSigners: [
        {tag: 'cosigner#0', name: 'Me', accountXpubHex: XpubHex(KEY_A)},
        {tag: 'cosigner#1', name: 'Me', accountXpubHex: XpubHex(KEY_B)},
      ],
    })
    expect(selfTagIn(shared, KEY_B)?.tag).toBe('cosigner#1')
  })
})

describe('definitionAsWallet', () => {
  it('marks only our row as self, and only when we supplied a key', () => {
    const withSelf = definitionAsWallet(definition(), {
      id: 'x',
      createdAt: 'now',
      selfXpubHex: KEY_A,
      selfGroupId: 'group-1',
    })
    expect(withSelf.coSigners.map((c) => c.isSelf)).toEqual([true, undefined])
    expect(withSelf.selfGroupId).toBe('group-1')

    const without = definitionAsWallet(definition(), {id: 'x', createdAt: 'now'})
    expect(without.coSigners.some((c) => c.isSelf === true)).toBe(false)
    expect(without.selfGroupId).toBeUndefined()
  })

  it('does not claim a signing group when our key is absent from the roster', () => {
    // Otherwise the wallet offers a witness this device cannot produce.
    const wallet = definitionAsWallet(definition(), {
      id: 'x',
      createdAt: 'now',
      selfXpubHex: KEY_C,
      selfGroupId: 'group-1',
    })
    expect(wallet.selfGroupId).toBeUndefined()
  })

  it('stamps our own createdAt, never the sender’s', () => {
    const wallet = definitionAsWallet(definition(), {id: 'x', createdAt: '2026-09-04T10:00:00.000Z'})
    expect(wallet.createdAt).toBe('2026-09-04T10:00:00.000Z')
  })

  it('leaves the registration unknown rather than guessing a status', () => {
    // 'skipped', 'pending' and 'published' are each a claim about a decision made
    // on another device. Absent is the only true answer from here.
    expect(definitionAsWallet(definition(), {id: 'x', createdAt: 'now'}).registration).toBeUndefined()
  })
})

describe('existingForDefinition', () => {
  it('finds the wallet already here', () => {
    const mine = asWallet(definition())
    expect(existingForDefinition(definition(), [mine])?.id).toBe('local-1')
  })

  it('matches through a local rename and through different co-signer labels', () => {
    // The same roster and template derive the same addresses, so it is the same
    // wallet: a re-share after a rename must not add a second record for one
    // address, which would show as two wallets with the same balance.
    const renamed = asWallet(definition(), {
      name: 'House money',
      coSigners: [
        {tag: 'cosigner#0', name: 'me', accountXpubHex: XpubHex(KEY_A)},
        {tag: 'cosigner#1', name: 'A. Smith', accountXpubHex: XpubHex(KEY_B), isSelf: true},
      ],
    })
    expect(existingForDefinition(definition(), [renamed])?.id).toBe('local-1')
  })

  it('does not match a different roster, template, network or account index', () => {
    const mine = asWallet(definition())
    const others: SharedWalletDefinition[] = [
      definition({
        coSigners: [
          {tag: 'cosigner#0', name: 'Jordi', accountXpubHex: XpubHex(KEY_A)},
          {tag: 'cosigner#1', name: 'Sam', accountXpubHex: XpubHex(KEY_C)},
        ],
      }),
      definition({paymentTemplate: {kind: 'any', scripts: template.scripts}}),
      definition({network: Address.Network.Testnet}),
      definition({accountIndex: 1}),
    ]
    for (const other of others) expect(existingForDefinition(other, [mine])).toBeNull()
  })

  it('does not match when the same keys sit under different tags', () => {
    // Tag position binds a key to a leaf of the script, so swapping them is a
    // different spending rule even with the same people in it.
    const swapped = definition({
      coSigners: [
        {tag: 'cosigner#0', name: 'Jordi', accountXpubHex: XpubHex(KEY_B)},
        {tag: 'cosigner#1', name: 'Alex', accountXpubHex: XpubHex(KEY_A)},
      ],
    })
    expect(existingForDefinition(swapped, [asWallet(definition())])).toBeNull()
  })
})

describe('checkImport', () => {
  it('accepts a definition for the active network that is not here yet', () => {
    const ok = checkImport(definition(), {activeNetwork: Address.Network.Mainnet, existing: []})
    expect(Either.isRight(ok)).toBe(true)
  })

  it('refuses a definition for another network, and says which', () => {
    // The registry is keyed by network: imported under the wrong scope it would
    // vanish on switching back and derive addresses nobody can fund.
    const refused = checkImport(definition(), {activeNetwork: Address.Network.Testnet, existing: []})
    expect(Either.isLeft(refused) && refused.left).toEqual({
      kind: 'wrong-network',
      definitionNetwork: Address.Network.Mainnet,
    })
  })

  it('refuses one already here and hands back the wallet, so the caller can open it', () => {
    const mine = asWallet(definition())
    const refused = checkImport(definition(), {activeNetwork: Address.Network.Mainnet, existing: [mine]})
    expect(Either.isLeft(refused) && refused.left.kind).toBe('already-present')
    if (Either.isLeft(refused) && refused.left.kind === 'already-present') {
      expect(refused.left.wallet.id).toBe('local-1')
    }
  })
})
