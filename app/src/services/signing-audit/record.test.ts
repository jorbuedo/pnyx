import {hex, sha256} from '@pnyx/crypto'
import type {SigningRequest, SigningSuccess} from '@pnyx/signing-service'
import {describe, expect, it} from 'vitest'
import {
  appendEntry,
  auditEntryId,
  buildCeremonyEntry,
  buildInfraEntry,
  digestOfHex,
  messageSubjectOf,
  outcomeOf,
  subjectsOf,
} from './record'
import {approvalOfPurpose, isFundsPurpose, type SigningPurpose} from './types'

const BODY = 'a1b2c3'
const PAYLOAD = 'deadbeef'

const txRequest = (overrides: {groupId?: string; signOnly?: boolean; accountIndex?: number} = {}): SigningRequest => ({
  groupId: overrides.groupId ?? 'group-1',
  ...(overrides.accountIndex === undefined ? {} : {accountIndex: overrides.accountIndex}),
  payload: {
    _tag: 'CardanoTx',
    bodyHex: BODY,
    networkId: 1,
    ...(overrides.signOnly === undefined ? {} : {signOnly: overrides.signOnly}),
  },
})

const dataRequest = (): SigningRequest => ({
  groupId: 'group-1',
  payload: {
    _tag: 'CardanoData',
    addressHex: 'aabb',
    payloadHex: PAYLOAD,
    signingPath: "m/1852'/1815'/0'/0/0",
    networkId: 1,
  },
})

const submitted = (txHash: string): SigningSuccess => ({_tag: 'TxSubmitted', txHash, signedTxHex: 'ff'})
const signedOnly: SigningSuccess = {_tag: 'TxSignedOnly', witnessSetHex: 'ff'}

describe('digestOfHex', () => {
  it('is SHA-256 of the decoded bytes, not of the hex text', () => {
    const expected = hex.encode(sha256(new Uint8Array([0xa1, 0xb2, 0xc3])))
    expect(digestOfHex(BODY)).toBe(expected)
    expect(digestOfHex(BODY)).not.toBe(hex.encode(sha256(new TextEncoder().encode(BODY))))
  })

  it('accepts either case and digests the same bytes', () => {
    expect(digestOfHex('A1B2C3')).toBe(digestOfHex('a1b2c3'))
  })

  // A false digest would be worse than none: it would claim the wrong payload was signed.
  it('yields an empty digest for malformed hex rather than digesting the literal', () => {
    expect(digestOfHex('not-hex')).toBe('')
    expect(digestOfHex('abc')).toBe('')
  })
})

describe('subjectsOf', () => {
  it('never stores the signed bytes — only their digest', () => {
    const [subject] = subjectsOf([txRequest()], [submitted('hash-1')])
    expect(JSON.stringify(subject)).not.toContain(BODY)
    expect(subject).toMatchObject({kind: 'transaction', txHash: 'hash-1', bodyDigestHex: digestOfHex(BODY)})
  })

  it('omits the tx hash when the result was a witness set rather than a broadcast', () => {
    const [subject] = subjectsOf([txRequest({signOnly: true})], [signedOnly])
    expect(subject).toMatchObject({kind: 'transaction', signOnly: true})
    expect(subject).not.toHaveProperty('txHash')
  })

  it('records a message payload as a digest plus its byte length, not its content', () => {
    const [subject] = subjectsOf([dataRequest()], [{_tag: 'DataSigned', signature: 'aa', key: 'bb'}])
    expect(subject).toEqual({
      kind: 'message',
      payloadDigestHex: digestOfHex(PAYLOAD),
      payloadByteLength: 4,
      signer: 'aabb',
      signerKind: 'cardano-address-hex',
    })
    expect(JSON.stringify(subject)).not.toContain(PAYLOAD)
  })

  // A leg that was signed but whose submit failed is precisely what this log exists to show.
  it('keeps a subject for every request even when fewer results came back', () => {
    const subjects = subjectsOf([txRequest(), txRequest(), txRequest()], [submitted('hash-1')])
    expect(subjects).toHaveLength(3)
    expect(subjects[0]).toHaveProperty('txHash', 'hash-1')
    expect(subjects[1]).not.toHaveProperty('txHash')
    expect(subjects[2]).not.toHaveProperty('txHash')
  })
})

describe('outcomeOf', () => {
  it('is submitted only when every leg landed', () => {
    expect(outcomeOf([txRequest(), txRequest()], [submitted('a'), submitted('b')])).toBe('submitted')
  })

  // The misreport this surface exists to prevent: a partially-landed chain is not "submitted".
  it('is failed when a chain landed only some of its legs', () => {
    expect(outcomeOf([txRequest(), txRequest()], [submitted('a')])).toBe('failed')
  })

  it('is signed when the result was a witness set', () => {
    expect(outcomeOf([txRequest({signOnly: true})], [signedOnly])).toBe('signed')
  })

  it('is failed when nothing was produced', () => {
    expect(outcomeOf([txRequest()], [])).toBe('failed')
  })
})

describe('buildCeremonyEntry', () => {
  it('derives the approval from the purpose rather than accepting one', () => {
    const entry = buildCeremonyEntry({
      context: {purpose: 'send', origin: null},
      requests: [txRequest()],
      results: [submitted('hash-1')],
      at: 1_700_000_000_000,
      seq: 1,
    })
    expect(entry.approval).toBe('reviewed')
    expect(entry.outcome).toBe('submitted')
    expect(entry.groupId).toBe('group-1')
    // ⚠️ `null`, not 0. This request names no account, and the entry used to record account 0 for it —
    // an audit trail asserting a fact the signature never carried.
    expect(entry.accountIndex).toBeNull()
  })

  it('keeps the requesting origin verbatim', () => {
    const entry = buildCeremonyEntry({
      context: {purpose: 'dapp-tx', origin: 'https://app.example'},
      requests: [txRequest({signOnly: true})],
      results: [signedOnly],
      at: 1,
      seq: 1,
    })
    expect(entry.origin).toBe('https://app.example')
  })

  it('forces a failed outcome when the ceremony threw, even if legs landed', () => {
    const entry = buildCeremonyEntry({
      context: {purpose: 'send', origin: null},
      requests: [txRequest()],
      results: [submitted('hash-1')],
      at: 1,
      seq: 1,
      failureReason: 'submit rejected',
    })
    expect(entry.outcome).toBe('failed')
    expect(entry.failureReason).toBe('submit rejected')
    // The leg that did land is still recorded.
    expect(entry.subjects[0]).toHaveProperty('txHash', 'hash-1')
  })

  it('carries the declared account index', () => {
    const entry = buildCeremonyEntry({
      context: {purpose: 'send', origin: null},
      requests: [txRequest({accountIndex: 3})],
      results: [submitted('h')],
      at: 1,
      seq: 1,
    })
    expect(entry.accountIndex).toBe(3)
  })
})

describe('buildInfraEntry', () => {
  it('attributes an ID-slot signature to no wallet group', () => {
    const entry = buildInfraEntry({
      context: {purpose: 'identity-login', origin: null},
      subject: messageSubjectOf(PAYLOAD, 'aabb', 'cardano-address-hex'),
      at: 1,
      seq: 1,
    })
    expect(entry.groupId).toBeNull()
    expect(entry.accountIndex).toBeNull()
    expect(entry.approval).toBe('infra-exempt')
    expect(entry.outcome).toBe('signed')
  })
})

describe('purpose classification', () => {
  const PURPOSES: readonly SigningPurpose[] = [
    'send',
    'stake',
    'swap',
    'consolidate',
    'dust',
    'cosign',
    'dapp-tx',
    'dapp-message',
    'koios-register',
    'steelswap-register',
    'identity-login',
  ]

  // The bright line of item 41: a funds signature is never infra-exempt.
  it('classifies every purpose, and every funds purpose as reviewed', () => {
    for (const purpose of PURPOSES) {
      expect(approvalOfPurpose(purpose)).toMatch(/^(reviewed|infra-exempt)$/)
      expect(isFundsPurpose(purpose)).toBe(approvalOfPurpose(purpose) === 'reviewed')
    }
  })

  it('never marks a funds-wallet purpose infra-exempt', () => {
    const funds: readonly SigningPurpose[] = ['send', 'stake', 'swap', 'consolidate', 'dust', 'cosign', 'dapp-tx']
    for (const purpose of funds) expect(approvalOfPurpose(purpose)).toBe('reviewed')
  })
})

describe('appendEntry', () => {
  const entryAt = (at: number) =>
    buildCeremonyEntry({
      context: {purpose: 'send', origin: null},
      requests: [txRequest()],
      results: [submitted(`h${at}`)],
      at,
      seq: at,
    })

  it('puts the newest entry first', () => {
    const list = appendEntry(appendEntry([], entryAt(1)), entryAt(2))
    expect(list.map((e) => e.at)).toEqual([2, 1])
  })

  // Collapsing identical signatures would hide a replay — the thing a reader is looking for.
  it('does not deduplicate identical signatures', () => {
    const first = entryAt(1)
    const list = appendEntry([first], {...first, id: 'other'})
    expect(list).toHaveLength(2)
  })

  it('drops the oldest beyond the cap', () => {
    const list = [1, 2, 3, 4, 5].reduce<readonly ReturnType<typeof entryAt>[]>(
      (acc, at) => appendEntry(acc, entryAt(at), 3),
      [],
    )
    expect(list).toHaveLength(3)
    expect(list.map((e) => e.at)).toEqual([5, 4, 3])
  })

  // Ordering is by `at`, not by insertion: a late-arriving OLD entry does not displace a
  // newer one. Mixing the two orderings dropped a middle entry entirely.
  it('orders by timestamp regardless of append order', () => {
    const list = [5, 1, 4, 2, 3].reduce<readonly ReturnType<typeof entryAt>[]>(
      (acc, at) => appendEntry(acc, entryAt(at), 3),
      [],
    )
    expect(list.map((e) => e.at)).toEqual([5, 4, 3])
  })

  const infraAt = (at: number) =>
    buildInfraEntry({
      context: {purpose: 'identity-login', origin: null},
      subject: messageSubjectOf(PAYLOAD, 'x', 'mn-addr'),
      at,
      seq: at,
    })

  // Every launch signs a forum sign-in, so a flat cap would let routine chatter evict the
  // funds signatures a compromise would actually show up in.
  it('evicts infrastructure entries before a funds signature', () => {
    let list: readonly ReturnType<typeof entryAt>[] = [entryAt(1)]
    for (const at of [2, 3, 4, 5, 6]) list = appendEntry(list, infraAt(at), 3)
    expect(list).toHaveLength(3)
    // The lone funds signature is the OLDEST entry and still survives.
    expect(list.some((e) => e.purpose === 'send' && e.at === 1)).toBe(true)
    expect(list.filter((e) => e.approval === 'infra-exempt').map((e) => e.at)).toEqual([6, 5])
  })

  it('only drops a funds signature once funds signatures alone exceed the cap', () => {
    let list: readonly ReturnType<typeof entryAt>[] = []
    for (const at of [1, 2, 3, 4]) list = appendEntry(list, entryAt(at), 3)
    expect(list.map((e) => e.at)).toEqual([4, 3, 2])
  })

  // Without a sub-cap the store becomes almost entirely sign-ins, burying the funds rows
  // even though eviction never drops them.
  it('bounds automatic entries independently of the total cap', () => {
    let list: readonly ReturnType<typeof entryAt>[] = []
    for (const at of [1, 2, 3, 4, 5, 6, 7, 8]) list = appendEntry(list, infraAt(at), 100, 3)
    expect(list).toHaveLength(3)
    expect(list.map((e) => e.at)).toEqual([8, 7, 6])
  })

  it('does not let the automatic sub-cap evict funds signatures', () => {
    let list: readonly ReturnType<typeof entryAt>[] = [entryAt(1), entryAt(2)]
    for (const at of [3, 4, 5, 6, 7]) list = appendEntry(list, infraAt(at), 100, 2)
    expect(list.filter((e) => e.approval === 'reviewed').map((e) => e.at)).toEqual([2, 1])
    expect(list.filter((e) => e.approval === 'infra-exempt').map((e) => e.at)).toEqual([7, 6])
  })

  it('keeps the merged list newest-first after eviction', () => {
    let list: readonly ReturnType<typeof entryAt>[] = [entryAt(10)]
    for (const at of [20, 30]) list = appendEntry(list, infraAt(at), 2)
    expect(list.map((e) => e.at)).toEqual([30, 10])
  })
})

describe('auditEntryId', () => {
  it('distinguishes entries written in the same millisecond', () => {
    expect(auditEntryId(1_700_000_000_000, 1)).not.toBe(auditEntryId(1_700_000_000_000, 2))
  })
})
