import {beforeEach, describe, expect, it} from 'vitest'
import {clearComposerDraft, readComposerDraft, registerComposerDraft} from './composer-draft'

beforeEach(() => clearComposerDraft())

describe('composer draft', () => {
  it('reads back the body under the id it was registered with', () => {
    const id = registerComposerDraft('web+cardano://stake?poolId=pool1abc')
    expect(readComposerDraft(id)).toBe('web+cardano://stake?poolId=pool1abc')
  })

  it('does not consume on read', () => {
    // Picking a conversation, backing out and picking another is ordinary. A
    // consumed draft would leave the second thread empty with nothing to say why.
    const id = registerComposerDraft('body')
    expect(readComposerDraft(id)).toBe('body')
    expect(readComposerDraft(id)).toBe('body')
  })

  it('is empty for an id it does not hold', () => {
    // A stale id from an earlier errand must not re-seed a thread with something
    // the user already sent or abandoned.
    const first = registerComposerDraft('first')
    registerComposerDraft('second')
    expect(readComposerDraft(first)).toBeUndefined()
    expect(readComposerDraft(undefined)).toBeUndefined()
    expect(readComposerDraft('draft_nope')).toBeUndefined()
  })

  it('is empty once cleared', () => {
    const id = registerComposerDraft('sent already')
    clearComposerDraft()
    expect(readComposerDraft(id)).toBeUndefined()
  })

  it('holds a body far too large for a route param', () => {
    // The reason it exists: a `TxEnvelope` is kilobytes of transaction, script and
    // witnesses, which is what used to be pushed through two URLs.
    const big = 'a'.repeat(8192)
    expect(readComposerDraft(registerComposerDraft(big))).toHaveLength(8192)
  })
})
