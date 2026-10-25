// Reviewing a transaction that already exists. The rules that matter: whose money is whose, and what
// the review must admit it cannot see. Every figure comes from the facts, never from a caller.

import {readFileSync} from 'node:fs'
import {describe, expect, it} from 'vitest'
import {type MidnightTransactionDraft, reviewMidnightTransaction} from './midnight.js'
import {midnightTxEffect} from './midnight-effect.js'
import type {MidnightTxFacts} from './midnight-facts.js'
import {readMidnightTxFactsJson} from './midnight-facts-wire.js'

const parseMidnightTxFactsJson = (json: string) => readMidnightTxFactsJson(json).facts

const NIGHT = '00'.repeat(32)
const A = 'fdf6ad91b11bb3af29308de0e54f055d5ccb5d705f920f524bfdfdaf57b11e41'
const B = 'fa5252115b9902967388a34d4358dd25413a29794b9d0aa28307171010a2aaee'
const RECIPIENT = '09'.repeat(32)
const NOW = 1_700_000_000

/** The real co-funded transfer the native reader emitted — see `midnight-facts-wire.test.ts`. */
const FIXTURE = readFileSync(new URL('./midnight-facts-fixture.json', import.meta.url), 'utf8')

const review = (
  facts: MidnightTxFacts,
  ourNames: ReadonlyMap<string, string>,
  over: Partial<MidnightTransactionDraft> = {},
) =>
  reviewMidnightTransaction({
    network: 'preprod',
    origin: 'agent',
    facts,
    effect: midnightTxEffect({facts, ourAddresses: [...ourNames.keys()]}),
    ourNames,
    fee: {by: 'sponsor'},
    nowSecs: NOW,
    ...over,
  })

const facts = (over: Partial<MidnightTxFacts> = {}): MidnightTxFacts => ({
  networkId: 'preprod',
  intents: [],
  shieldedOutputs: 0,
  hasShielded: false,
  understood: true,
  ...over,
})

const intent = (over: Record<string, unknown> = {}) => ({
  segment: 1,
  ttlSecs: NOW + 3600,
  guaranteed: {inputs: [], outputs: []},
  fallible: {inputs: [], outputs: []},
  calls: [],
  deploys: [],
  otherActions: 0,
  ...over,
})

const utxo = (value: bigint, owner: string) => ({colour: NIGHT, value, owner})

describe('reviewMidnightTransaction', () => {
  it('names each contributor’s own figure, from the offer rather than from the composer', () => {
    const view = review(
      parseMidnightTxFactsJson(FIXTURE),
      new Map([
        [A, 'Abandon 12'],
        [B, 'Abandon 15'],
      ]),
    )
    // A pledged 2,000,000 and B 4,000,000; both got their remainders back as change.
    const byName = new Map(view.parties.map((party) => [party.name ?? party.address, party.netByToken.get(NIGHT)]))
    expect(byName.get('Abandon 12')).toBe(-2_000_000n)
    expect(byName.get('Abandon 15')).toBe(-4_000_000n)
    expect(byName.get(RECIPIENT)).toBe(6_000_000n)
    expect(view.understood).toBe(true)
  })

  it('puts the largest payer first and the recipient last, stably', () => {
    const view = review(parseMidnightTxFactsJson(FIXTURE), new Map([[A, 'Abandon 12']]))
    expect(view.parties.map((party) => party.role)).toEqual(['pays', 'pays', 'receives'])
    expect(view.parties[0]?.netByToken.get(NIGHT)).toBe(-4_000_000n)
  })

  it('leaves a party we do not hold unnamed rather than guessing at it', () => {
    const view = review(parseMidnightTxFactsJson(FIXTURE), new Map([[A, 'Abandon 12']]))
    expect(view.parties.find((party) => party.address === B)?.name).toBeNull()
    expect(view.notes).not.toContain('entirely-between-our-wallets')
  })

  it('calls a transaction between our own wallets what it is', () => {
    const view = review(
      facts({intents: [intent({fallible: {inputs: [utxo(5n, A)], outputs: [utxo(5n, B)]}})]}),
      new Map([
        [A, 'Abandon 12'],
        [B, 'Abandon 15'],
      ]),
    )
    expect(view.notes).toContain('entirely-between-our-wallets')
    expect(view.notes).not.toContain('several-contributors')
  })

  it('notes several contributors only when more than one address pays', () => {
    const one = review(
      facts({intents: [intent({fallible: {inputs: [utxo(5n, A)], outputs: [utxo(5n, RECIPIENT)]}})]}),
      new Map([[A, 'Abandon 12']]),
    )
    expect(one.notes).not.toContain('several-contributors')
    expect(review(parseMidnightTxFactsJson(FIXTURE), new Map([[A, 'Abandon 12']])).notes).toContain(
      'several-contributors',
    )
  })

  it('reports a partial effect as partial, before any figure', () => {
    const view = review(facts({understood: false}), new Map([[A, 'Abandon 12']]))
    expect(view.understood).toBe(false)
    expect(view.warnings[0]).toBe('effect-not-understood')
    expect(view.gaps).toContainEqual({kind: 'unreadable-transaction'})
  })

  it('warns about a transaction on another network, and says nothing when it did not state one', () => {
    const other = review(facts({networkId: 'mainnet'}), new Map([[A, 'Abandon 12']]))
    expect(other.warnings).toContain('transaction-on-another-network')
    expect(other.transactionNetwork).toBe('mainnet')
    // ⚠️ An unread network id is no claim: warning on it would fire on every transaction the ledger's
    // JS reader produced, because those bindings expose no accessor for it.
    const silent = review(facts({networkId: ''}), new Map([[A, 'Abandon 12']]))
    expect(silent.warnings).not.toContain('transaction-on-another-network')
  })

  it('says a shielded offer hides amounts, and reports it as a count', () => {
    const view = review(facts({hasShielded: true, shieldedOutputs: 3}), new Map([[A, 'Abandon 12']]))
    expect(view.warnings).toContain('shielded-amounts-hidden')
    expect(view.shieldedOutputs).toBe(3)
  })

  it('admits it does not describe a contract call', () => {
    const view = review(
      facts({intents: [intent({calls: [{address: 'ab'.repeat(32), entryPoint: 'claimName'}]})]}),
      new Map([[A, 'Abandon 12']]),
    )
    expect(view.warnings).toContain('calls-not-described')
    expect(view.calls[0]?.entryPoint).toBe('claimName')
  })

  it('surfaces an action it could not name at all', () => {
    const view = review(facts({intents: [intent({otherActions: 1})]}), new Map([[A, 'Abandon 12']]))
    expect(view.warnings).toContain('unnamed-actions')
  })

  it('refuses to hide an expired transaction, and takes the earliest expiry', () => {
    const view = review(
      facts({intents: [intent({ttlSecs: NOW + 60}), intent({segment: 2, ttlSecs: NOW - 1})]}),
      new Map([[A, 'Abandon 12']]),
    )
    expect(view.expiresAtSecs).toBe(NOW - 1)
    expect(view.warnings).toContain('already-expired')
    expect(view.notes).toContain('several-segments')
  })

  it('states an unreadable expiry as unknown rather than as no expiry', () => {
    const view = review(facts({intents: [intent({ttlSecs: null})]}), new Map([[A, 'Abandon 12']]))
    expect(view.expiresAtSecs).toBeNull()
    expect(view.warnings).not.toContain('already-expired')
  })

  it('says when nothing of ours moves, and stays quiet when it cannot tell', () => {
    const nothing = review(
      facts({intents: [intent({fallible: {inputs: [utxo(5n, B)], outputs: [utxo(5n, RECIPIENT)]}})]}),
      new Map([[A, 'Abandon 12']]),
    )
    expect(nothing.warnings).toContain('nothing-of-ours-moves')
    // ⚠️ With no addresses of our own, everything reads as a stranger's — so this would fire on every
    // transaction while saying nothing. The gap is reported instead.
    const blind = review(facts({intents: [intent({fallible: {inputs: [utxo(5n, B)], outputs: []}})]}), new Map())
    expect(blind.warnings).not.toContain('nothing-of-ours-moves')
    expect(blind.gaps).toContainEqual({kind: 'own-addresses-unknown'})
  })

  it('does not invent a party for an entry whose owner would not read', () => {
    const view = review(
      facts({intents: [intent({fallible: {inputs: [{colour: '', value: 0n, owner: ''}], outputs: []}})]}),
      new Map([[A, 'Abandon 12']]),
    )
    expect(view.parties).toEqual([])
    expect(view.understood).toBe(false)
    expect(view.gaps).toContainEqual({kind: 'unreadable-entry', count: 1})
  })

  it('omits a token whose net is zero for a party — a pass-through is not a movement', () => {
    const view = review(
      facts({intents: [intent({fallible: {inputs: [utxo(5n, A)], outputs: [utxo(5n, A)]}})]}),
      new Map([[A, 'Abandon 12']]),
    )
    expect(view.parties).toEqual([])
    expect(view.delta.size).toBe(0)
  })
})
