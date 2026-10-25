import {describe, expect, it} from 'vitest'
import {decodeSignDataPayload} from '../../components/DappBrowser/sign-data-decode'
import {DEFAULT_DONE_HREF, doneDestination, isMessageLeg, type ReviewLeg} from './review-handoff'

const utf8ToHex = (s: string): string =>
  [...new TextEncoder().encode(s)].map((b) => b.toString(16).padStart(2, '0')).join('')

const messageLeg = (payloadHex: string): ReviewLeg => ({
  kind: 'message',
  requestedBy: 'external',
  message: decodeSignDataPayload(payloadHex),
  addressHex: '00ab',
  origin: 'https://example.test',
  request: {
    groupId: 'g',
    payload: {_tag: 'CardanoData', addressHex: '00ab', payloadHex, signingPath: 'm/0', networkId: 1},
  },
})

describe('isMessageLeg', () => {
  it('identifies a message leg', () => {
    expect(isMessageLeg(messageLeg(utf8ToHex('hello')))).toBe(true)
  })

  // The transaction variant's discriminant is optional so existing producers
  // compile unchanged — which only works if an absent `kind` still reads as a
  // transaction.
  it('treats a leg with no explicit kind as a transaction', () => {
    const leg = {
      reviewed: {} as never,
      request: {groupId: 'g', payload: {_tag: 'CardanoTx', bodyHex: 'aa', networkId: 1}},
    } satisfies ReviewLeg
    expect(isMessageLeg(leg)).toBe(false)
  })

  it('treats an explicit transaction kind as a transaction', () => {
    const leg = {
      kind: 'transaction',
      reviewed: {} as never,
      request: {groupId: 'g', payload: {_tag: 'CardanoTx', bodyHex: 'aa', networkId: 1}},
    } satisfies ReviewLeg
    expect(isMessageLeg(leg)).toBe(false)
  })
})

describe('a message leg renders the bytes it signs', () => {
  // The load-bearing invariant of the message review: what the user is shown must
  // be derived from the payload that will actually be signed, never from a
  // requester-supplied summary. Asserted by construction — the decoded subject and
  // the request's payloadHex come from one value.
  it.each([
    ['printable text', utf8ToHex('Confirm you own this wallet.')],
    ['non-printable bytes', 'deadbeeffeedface'],
  ])('pairs the decoded subject with the signed payload for %s', (_label, payloadHex) => {
    const leg = messageLeg(payloadHex)
    if (!isMessageLeg(leg)) throw new Error('expected a message leg')
    expect(leg.request.payload).toMatchObject({payloadHex})
    expect(leg.message).toEqual(decodeSignDataPayload(payloadHex))
  })

  it('surfaces uninterpretable bytes as hex rather than inventing text', () => {
    const leg = messageLeg('deadbeeffeedface')
    if (!isMessageLeg(leg)) throw new Error('expected a message leg')
    expect(leg.message.kind).toBe('hex')
  })

  it('parses a real SIWE payload into fields instead of one opaque blob', () => {
    const siwe = [
      'pnyx.example wants you to sign in with your Cardano account:',
      'addr1qxy2',
      '',
      'Sign in to Pnyx',
      '',
      'URI: https://pnyx.example',
      'Version: 1',
      'Nonce: abc123',
    ].join('\n')
    const leg = messageLeg(utf8ToHex(siwe))
    if (!isMessageLeg(leg)) throw new Error('expected a message leg')
    expect(leg.message.kind).toBe('siwe')
    if (leg.message.kind !== 'siwe') return
    expect(leg.message.fields.domain).toBe('pnyx.example')
    expect(leg.message.fields.nonce).toBe('abc123')
  })
})

describe('doneDestination', () => {
  it('lands a producer with no opinion on the wallet home', () => {
    // The bug: an omitted `doneHref` fell back to `back()`, which walked the user straight back
    // into the send funnel they had just completed.
    expect(doneDestination(undefined)).toBe(DEFAULT_DONE_HREF)
  })

  it('keeps a producer that must not leave where it is', () => {
    // ⚠️ `null` is not "no opinion". An air-gap screen holds the signature the user came for and
    // shows it after signing; sending it home would discard that. Collapsing the two absences
    // would break exactly this case.
    expect(doneDestination(null)).toBeNull()
  })

  it('honours an explicit destination', () => {
    expect(doneDestination('/wallet/dust')).toBe('/wallet/dust')
  })

  it('treats the two absences as different things', () => {
    expect(doneDestination(undefined)).not.toBe(doneDestination(null))
  })
})
