import type {ReviewedOperation, ReviewedTransaction} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import {METADATA_LABELS} from '../cardano/metadata/label-registry'
import {type ContextPackId, detectContextPacks, MAX_PACKS, PACK_BY_LABEL, PACKS} from './context-packs'

const tx = (over: Partial<ReviewedTransaction> = {}): ReviewedTransaction =>
  ({metadata: {}, operations: [], ...over}) as unknown as ReviewedTransaction

const op = (kind: string): ReviewedOperation => ({kind}) as ReviewedOperation

describe('the registry forces a decision', () => {
  it('has a pack or an explicit null for every registered label', () => {
    // TypeScript cannot enforce this — the registry is keyed by `string`, because that is how a
    // label arrives off chain — so a label added there and forgotten here would silently get no
    // context at all. That is the failure this test exists for.
    for (const label of Object.keys(METADATA_LABELS)) {
      expect(Object.hasOwn(PACK_BY_LABEL, label), `PACK_BY_LABEL is missing label ${label}`).toBe(true)
    }
  })

  it('names no label the registry does not have', () => {
    for (const label of Object.keys(PACK_BY_LABEL)) {
      expect(Object.hasOwn(METADATA_LABELS, label), `PACK_BY_LABEL has unregistered label ${label}`).toBe(true)
    }
  })

  it('maps every label to a pack that exists', () => {
    for (const [label, id] of Object.entries(PACK_BY_LABEL)) {
      if (id === null) continue
      expect(Object.hasOwn(PACKS, id), `label ${label} maps to unknown pack ${id}`).toBe(true)
    }
  })
})

describe('every snippet obeys the rules that make it safe', () => {
  const entries = Object.entries(PACKS) as readonly [ContextPackId, string][]

  it('states no figure', () => {
    // ⚠️ Every number in the prompt is computed from the transaction's bytes. A snippet is the
    // only authored prose there, so a number in one is indistinguishable — to the model — from a
    // fact off the chain.
    for (const [id, text] of entries) {
      expect(/\d/.test(text.replace(/CIP-\d+|label \d+|Label \d+|\bv?\d+\.\d+\b/g, '')), `pack ${id}`).toBe(false)
    }
  })

  it('states the protocol plainly instead of hedging it', () => {
    // ⚠️ Dev-lead call, 2026-08-17. The reader is a beginner trying to understand their own
    // transaction, the screen already carries an accuracy disclaimer, and this model mirrors
    // prompt register back at the reader — so hedging every label bought protection against a
    // rare forgery by frightening every ordinary user. A label registered to Reeve says Reeve.
    const hedges = /\bCLAIMS?\b|unauthenticated|nothing verifies|nothing on chain checks|purports|allegedly/i
    for (const [id, text] of entries) {
      expect(hedges.test(text), `pack ${id} hedges: ${text.slice(0, 90)}`).toBe(false)
    }
  })

  it("promises nothing about the payload, which stays the author's", () => {
    // Not a caveat, a scope limit: a snippet describes the protocol. The transaction's own
    // author-written strings go to the prompt's UNTRUSTED block, which has its own framing.
    for (const [id, text] of entries) {
      expect(/genuine|verified|authentic|trustworthy|guaranteed/i.test(text), `pack ${id}`).toBe(false)
    }
  })

  it('stays short enough to be worth its context', () => {
    for (const [id, text] of entries) expect(text.length, `pack ${id}`).toBeLessThan(600)
  })
})

describe('detectContextPacks', () => {
  it('gives an ordinary transfer nothing at all', () => {
    // The whole point of gating: a plain send must not pay for knowledge it cannot use.
    expect(detectContextPacks(tx())).toEqual([])
  })

  it('recognises Reeve from its label', () => {
    expect(detectContextPacks(tx({metadata: {'1447': {}}}))).toEqual(['reeve'])
  })

  it('ignores an unregistered label rather than inventing context for it', () => {
    // ~98.5% of the label space in use is unregistered.
    expect(detectContextPacks(tx({metadata: {'99999': {}}}))).toEqual([])
  })

  it('never treats a CIP-20 message as a protocol', () => {
    expect(detectContextPacks(tx({metadata: {'674': 'hello'}}))).toEqual([])
  })

  it('finds governance from the operations when no label says so', () => {
    expect(detectContextPacks(tx({operations: [op('vote-delegation')]}))).toEqual(['governance'])
  })

  it('does not double up when a label and an operation agree', () => {
    const packs = detectContextPacks(tx({metadata: {'1694': {}}, operations: [op('voting-procedures')]}))
    expect(packs).toEqual(['governance'])
  })

  it('takes CIP-113 from the caller, which is the only thing that knows', () => {
    expect(detectContextPacks(tx(), {isCip113: true})).toEqual(['cip113-transfer'])
  })

  it('resolves several labels in ascending order, not object order', () => {
    const packs = detectContextPacks(tx({metadata: {'1564': {}, '721': {}}}))
    expect(packs).toEqual(['nft-metadata', 'marlowe'])
  })

  it('caps what it spends', () => {
    const packs = detectContextPacks(tx({metadata: {'721': {}, '1447': {}, '1564': {}, '1854': {}}}))
    expect(packs).toHaveLength(MAX_PACKS)
  })

  it('is not confused by a label-shaped key that is not a number', () => {
    expect(detectContextPacks(tx({metadata: {toString: {}, '1447': {}}}))).toEqual(['reeve'])
  })
})
