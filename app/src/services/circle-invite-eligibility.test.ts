import {describe, expect, it} from 'vitest'
import {inviteEligibleWallets, requirementLines, type WalletForInvite} from './circle-invite-eligibility'

const wallet = (over: Partial<WalletForInvite> & {groupId: string}): WalletForInvite => ({
  name: over.groupId,
  source: 'mnemonic',
  hasCardano: true,
  accountIndex: 0,
  ...over,
})

describe('inviteEligibleWallets', () => {
  it('offers software wallets that hold a Cardano account', () => {
    const {eligible} = inviteEligibleWallets([wallet({groupId: 'a'}), wallet({groupId: 'b', name: 'Savings'})])
    expect(eligible).toEqual([
      {groupId: 'a', name: 'a', accountIndex: 0},
      {groupId: 'b', name: 'Savings', accountIndex: 0},
    ])
  })

  // ⚠️ Not a policy — a limitation. A Ledger will not export the stake private key this signs with,
  // and offering one that fails at the prompt is worse than not offering it. The other three sources
  // fail for their own reasons, all of them "this app cannot reach a key to sign with".
  it.each(['hardware', 'read-only', 'imported-xpriv', 'multisig'] as const)('hides a %s wallet', (source) => {
    const result = inviteEligibleWallets([wallet({groupId: 'a'}), wallet({groupId: 'x', source})])
    expect(result.eligible.map((w) => w.groupId)).toEqual(['a'])
    expect(result.hiddenNoKey).toBe(1)
  })

  it('hides wallets with no Cardano account and counts them separately', () => {
    const result = inviteEligibleWallets([wallet({groupId: 'a'}), wallet({groupId: 'btc', hasCardano: false})])
    expect(result.eligible.map((w) => w.groupId)).toEqual(['a'])
    expect(result.hiddenNoCardano).toBe(1)
    // Two different reasons, counted apart: "your Ledger cannot do this" and "that wallet has no
    // Cardano account" are different things to tell somebody.
    expect(result.hiddenNoKey).toBe(0)
  })

  it('reports an empty device honestly rather than as a hidden count', () => {
    expect(inviteEligibleWallets([])).toEqual({eligible: [], hiddenNoKey: 0, hiddenNoCardano: 0})
  })

  // The signature comes from one account of the wallet, and which one has to travel with the choice
  // — a stake key at account 3 is a different account_info row from the same wallet's account 0.
  it('carries the account a signature would come from', () => {
    const {eligible} = inviteEligibleWallets([wallet({groupId: 'a', accountIndex: 3})])
    expect(eligible[0]?.accountIndex).toBe(3)
  })
})

describe('requirementLines', () => {
  it('reads a threshold in ADA, not lovelace', () => {
    expect(requirementLines([{kind: 'ada-threshold', param: '250000000'}])).toEqual([
      {kind: 'ada-threshold', ada: '250'},
    ])
  })

  it('carries the drep and pool ids through so a person can compare them', () => {
    expect(
      requirementLines([
        {kind: 'drep-delegated', param: 'drep1abc'},
        {kind: 'pool-member', param: 'pool1xyz'},
      ]),
    ).toEqual([
      {kind: 'drep-delegated', drepId: 'drep1abc'},
      {kind: 'pool-member', poolId: 'pool1xyz'},
    ])
  })

  // ⚠️ A build older than the service would otherwise render a *shorter* list than the circle has,
  // so somebody would pick a wallet against rules that are not all the rules and be refused with no
  // way to see why.
  it('shows a rule it does not recognise rather than dropping it', () => {
    expect(requirementLines([{kind: 'owns-a-cat', param: 'tabby'}])).toEqual([{kind: 'unknown', raw: 'owns-a-cat'}])
  })

  it('shows a malformed threshold as unknown rather than as a wrong number', () => {
    expect(requirementLines([{kind: 'ada-threshold', param: 'lots'}])).toEqual([
      {kind: 'unknown', raw: 'ada-threshold'},
    ])
  })

  it('shows a rule missing its parameter as unknown', () => {
    expect(requirementLines([{kind: 'pool-member', param: null}])).toEqual([{kind: 'unknown', raw: 'pool-member'}])
  })

  it('keeps every rule, in order', () => {
    const lines = requirementLines([
      {kind: 'ada-threshold', param: '1000000'},
      {kind: 'pool-member', param: 'pool1a'},
    ])
    expect(lines).toHaveLength(2)
    expect(lines[0]?.kind).toBe('ada-threshold')
  })
})
