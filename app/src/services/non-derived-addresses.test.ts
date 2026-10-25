import type {ChainId} from '@pnyx/config'
import type {WalletGroup, WalletGroupId} from '@pnyx/wallet'
import {describe, expect, it} from 'vitest'
import {nonDerivedAddresses} from './non-derived-addresses'

const CARDANO = 'cardano:mainnet' as ChainId

const group = (
  id: string,
  source: WalletGroup['source'],
  chains: Record<string, {readonly nonDerivedAddresses?: readonly string[]}>,
): [WalletGroupId, WalletGroup] => [
  id as WalletGroupId,
  {
    groupId: id as WalletGroupId,
    name: id,
    createdAt: new Date(0),
    source,
    chains: new Map(
      Object.entries(chains).map(([chainId, cfg]) => [
        chainId as ChainId,
        {
          implementation: 'readOnly' as const,
          accounts: [{index: 0, enabled: true}],
          selectedAccountIndex: 0,
          ...(cfg.nonDerivedAddresses ? {nonDerivedAddresses: cfg.nonDerivedAddresses} : {}),
        },
      ]),
    ),
  },
]

describe('nonDerivedAddresses', () => {
  // ⚠️ The whole point: an HD wallet's book is rebuildable from its xpub, so the address
  // table is a cache for it. These two kinds had no second copy, and the table drops
  // itself on a schema bump.
  it('collects a shared wallet and a watch-only import, and ignores derived wallets', () => {
    const groups = new Map([
      group('g-hd', 'mnemonic', {[CARDANO]: {}}),
      group('g-shared', 'multisig', {[CARDANO]: {nonDerivedAddresses: ['addr1_script']}}),
      group('g-watch', 'read-only', {[CARDANO]: {nonDerivedAddresses: ['addr1_watched']}}),
    ])

    expect(nonDerivedAddresses(groups)).toEqual([
      {groupId: 'g-shared', chainId: CARDANO, index: 0, human: 'addr1_script', source: 'multisig'},
      {groupId: 'g-watch', chainId: CARDANO, index: 0, human: 'addr1_watched', source: 'read-only'},
    ])
  })

  it('gives each address the branch index its position implies', () => {
    const groups = new Map([group('g', 'multisig', {[CARDANO]: {nonDerivedAddresses: ['a', 'b', 'c']}})])
    expect(nonDerivedAddresses(groups).map((a) => a.index)).toEqual([0, 1, 2])
    expect(nonDerivedAddresses(groups).map((a) => a.human)).toEqual(['a', 'b', 'c'])
  })

  it('keeps chains apart within one group', () => {
    const groups = new Map([
      group('g', 'read-only', {
        [CARDANO]: {nonDerivedAddresses: ['addr1_x']},
        'bip122:000000000019d6689c085ae165831e93': {nonDerivedAddresses: ['bc1_y']},
      }),
    ])
    expect(nonDerivedAddresses(groups).map((a) => a.chainId)).toEqual([
      CARDANO,
      'bip122:000000000019d6689c085ae165831e93',
    ])
  })

  it('drops a blank entry rather than writing a row nothing can resolve', () => {
    const groups = new Map([group('g', 'multisig', {[CARDANO]: {nonDerivedAddresses: ['', '   ', 'addr1_real']}})])
    expect(nonDerivedAddresses(groups).map((a) => a.human)).toEqual(['addr1_real'])
  })

  it('is empty when nothing needs rebuilding', () => {
    expect(nonDerivedAddresses(new Map())).toEqual([])
    expect(nonDerivedAddresses(new Map([group('g', 'mnemonic', {[CARDANO]: {}})]))).toEqual([])
  })
})
