import {describe, expect, it} from 'vitest'
import type {LinkAction} from '../services/link-action'
import {linkActionSubjectFor} from './link-action-subject'

const POOL_ID = 'pool1qv9pzxqlyckngw6zf9g9whn9d3eh4qvg37tfmf9tk2uuqh3rx6y'
const TARGET = {kind: 'key', hashHex: 'a5b45515a3ff8cb7c02ce351834da324eb6dfc41b5779cb5e6b832aa'} as const

const payment = (over: Partial<Extract<LinkAction, {kind: 'payment-request'}>> = {}): LinkAction => ({
  kind: 'payment-request',
  address: 'addr1qxyz',
  lovelace: 5_000_000n,
  message: undefined,
  paymentId: undefined,
  asksForAssets: false,
  ...over,
})

describe('linkActionSubjectFor', () => {
  it('maps a payment request with everything the sheet shows', () => {
    const subject = linkActionSubjectFor(payment({message: 'lunch', paymentId: 'order-1', asksForAssets: true}), 'link')
    expect(subject).toEqual({
      kind: 'payment',
      prefill: {addressBech32: 'addr1qxyz', lovelace: 5_000_000n, origin: 'link'},
      note: 'lunch',
      paymentId: 'order-1',
      asksForAssets: true,
    })
  })

  it('is null for a payment with no address to pay', () => {
    // Classifies, but cannot be acted on — so no sheet rather than a sheet that
    // opens onto nothing.
    expect(linkActionSubjectFor(payment({address: '   '}), 'link')).toBeNull()
  })

  it('maps a pool delegation, carrying the id for the register lookup', () => {
    expect(linkActionSubjectFor({kind: 'stake-delegation', poolId: POOL_ID}, 'link')).toEqual({
      kind: 'delegation',
      prefill: {poolId: POOL_ID, drep: null, origin: 'link'},
      poolId: POOL_ID,
    })
  })

  it('maps a DRep delegation, carrying the canonical target alongside the id', () => {
    // The id is what the register is asked about; the target is what actually gets
    // delegated, and only the canonical form compares correctly.
    expect(linkActionSubjectFor({kind: 'drep-delegation', drepId: 'drep1abc', target: TARGET}, 'link')).toEqual({
      kind: 'delegation',
      prefill: {poolId: null, drep: TARGET, origin: 'link'},
      drepId: 'drep1abc',
      drepTarget: TARGET,
    })
  })

  it('lands the multisig pair rather than opening nothing', () => {
    // These used to return null on the grounds that they have their own flow and
    // their own consent. True of the flow — but the only caller that acts on null is
    // the QR/deep-link gate, where it meant an invitation to join a shared wallet
    // arrived as a silent bounce to home. Landing names it; the sheet still declines
    // to invent a reply channel for one.
    const invite: LinkAction = {kind: 'multisig-invite'}
    expect(linkActionSubjectFor(invite, 'link')).toEqual({kind: 'other', action: invite})
  })

  it('maps every remaining kind to `other`, carrying the action verbatim', () => {
    // This is what lets a link arriving from outside the app land on a screen
    // instead of acting. The card already renders these; the subject exists to put
    // that card behind a confirmation, so it copies the action rather than
    // describing it a second way.
    const dapp = {kind: 'dapp', url: 'https://example.com', host: 'example.com'} as const
    expect(linkActionSubjectFor(dapp, 'scan')).toEqual({kind: 'other', action: dapp})

    const connect = {kind: 'named-only', what: 'connect', detail: undefined} as const
    expect(linkActionSubjectFor(connect, 'scan')).toEqual({kind: 'other', action: connect})

    // A claim is acted on — the sheet's button opens the claim screen — and still
    // routed through `other`, because the question it asks is which wallet
    // receives, not which one spends.
    const claim = {
      kind: 'claim',
      faucetUrl: 'https://faucet.example/api',
      host: 'faucet.example',
      code: 'CODE1',
      params: {},
    } as const
    expect(linkActionSubjectFor(claim, 'scan')).toEqual({kind: 'other', action: claim})

    // Acted on rather than named, and still routed through the subject: the
    // confirmation is where the shared-seed warning is read.
    const backup = {kind: 'backup', link: 'web+cardano://backup?v=1&enc=abc'} as const
    expect(linkActionSubjectFor(backup, 'scan')).toEqual({kind: 'other', action: backup})

    const watch = {kind: 'watch-only', address: 'addr1xyz', name: undefined} as const
    expect(linkActionSubjectFor(watch, 'scan')).toEqual({kind: 'other', action: watch})

    const block = {kind: 'explorer', target: 'block', id: 'aa'} as const
    expect(linkActionSubjectFor(block, 'scan')).toEqual({kind: 'other', action: block})

    const tx = {kind: 'transaction', hash: 'a'.repeat(64)} as const
    expect(linkActionSubjectFor(tx, 'scan')).toEqual({kind: 'other', action: tx})
  })
})
