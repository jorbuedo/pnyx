// The on-demand documentation channel. What these pin is that it stays *usable*: an agent reads a
// description to decide whether to open a document, and reads a URI out of a list it was given.
import {describe, expect, it} from 'vitest'
import {findResource, RESOURCES, resourceDescriptors} from './resources.js'

describe('the resource catalogue', () => {
  it('has a unique uri per document', () => {
    const uris = RESOURCES.map((r) => r.uri)
    expect(new Set(uris).size).toBe(uris.length)
  })

  // A description is how an agent decides whether a document is worth the context. One that says
  // "documentation" costs a read to find out it was not.
  it('describes every document well enough to decide against reading it', () => {
    for (const doc of RESOURCES) {
      expect(doc.description.length, doc.uri).toBeGreaterThan(60)
      expect(doc.title.length, doc.uri).toBeGreaterThan(5)
      expect(doc.mimeType).toBe('text/markdown')
    }
  })

  it('carries real content, not a stub', () => {
    for (const doc of RESOURCES) expect(doc.text.length, doc.uri).toBeGreaterThan(500)
  })

  // ⚠️ Listing must stay cheap: the text is the whole reason resources exist as a separate channel from
  // `instructions`, and a list that carried it would cost exactly what it was meant to avoid.
  it('lists without the text', () => {
    for (const entry of resourceDescriptors()) {
      expect(entry).not.toHaveProperty('text')
      expect(entry.uri.startsWith('pnyx://')).toBe(true)
    }
    expect(resourceDescriptors().map((r) => r.uri)).toEqual(RESOURCES.map((r) => r.uri))
  })

  it('resolves a document by uri and nothing else', () => {
    expect(findResource('pnyx://guide/building')?.name).toBe('building-transactions')
    expect(findResource('pnyx://guide/nothing')).toBeUndefined()
    expect(findResource('building-transactions')).toBeUndefined()
  })

  // Every document names the tools it is about, or an agent that read it still cannot act.
  it('names the tools each document is about', () => {
    const named = RESOURCES.map((r) => r.text).join('\n')
    for (const tool of [
      'cardano_buildTransfer',
      'cardano_buildMintAndDistribute',
      'cardano_buildCoFundedSend',
      'cardano_signCoFunded',
      'cardano_buildConsolidation',
      'cardano_listHistory',
      'cardano_cip139_getProtocolParametersByLatest',
    ]) {
      expect(named, tool).toContain(tool)
    }
  })
})
