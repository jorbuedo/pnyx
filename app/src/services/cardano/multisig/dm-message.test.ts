import {Either} from 'effect'
import {describe, expect, it} from 'vitest'
import {readLinkAction} from '../../link-action'
import {buildCoSignerKeyMessage, buildInviteMessage} from './dm-message'
import {encodeAccountXvk} from './shared-key'

const XPUB_HEX = 'ab'.repeat(64)

describe('buildInviteMessage', () => {
  it('produces a link the reader turns back into a request card', () => {
    // The two ends of one contract: this builder and `readLinkAction`, which is
    // what the recipient's thread runs on every message it renders.
    expect(readLinkAction(buildInviteMessage())).toEqual({kind: 'multisig-invite'})
  })

  it('carries nothing about the wallet or the sender', () => {
    // It named the wallet being built — which may never exist — and the sender's
    // own funds-wallet label. The conversation already says who is asking.
    const link = buildInviteMessage()
    expect([...new URL(link).searchParams.keys()]).toEqual([])
  })
})

describe('buildCoSignerKeyMessage', () => {
  it('produces the same string the QR and share sheet carry', () => {
    const built = buildCoSignerKeyMessage(XPUB_HEX)
    if (Either.isLeft(built)) throw new Error('expected a link')
    const encoded = encodeAccountXvk(XPUB_HEX)
    if (Either.isLeft(encoded)) throw new Error('expected an encodable key')
    expect(built.right).toContain(encoded.right)
  })

  it('reads back as a co-signer key and nothing else', () => {
    const built = buildCoSignerKeyMessage(XPUB_HEX)
    if (Either.isLeft(built)) throw new Error('expected a link')
    expect(readLinkAction(built.right)).toEqual({kind: 'cosigner-key', accountXpubHex: XPUB_HEX})
  })

  it('reports a key it cannot encode rather than sending something unreadable', () => {
    expect(Either.isLeft(buildCoSignerKeyMessage('nothex'))).toBe(true)
  })
})
