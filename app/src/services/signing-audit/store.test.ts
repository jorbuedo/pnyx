import type {SigningRequest, SigningSuccess} from '@pnyx/signing-service'
import {beforeEach, describe, expect, it, vi} from 'vitest'

const backing = new Map<string, string>()
let failWrites = false

vi.mock('../../platform/storage', () => ({
  storage: {
    get: async (key: string) => backing.get(key) ?? null,
    set: async (key: string, value: string) => {
      if (failWrites) throw new Error('storage full')
      backing.set(key, String(value))
    },
    remove: async (key: string) => {
      backing.delete(key)
    },
  },
}))

const warn = vi.fn()
vi.mock('../../logger', () => ({logger: {warn: (...args: unknown[]) => warn(...args)}}))

const {
  clearSigningAudit,
  listSigningAudit,
  parseAuditEntry,
  recordInfraSignature,
  recordSigningAudit,
  SIGNING_AUDIT_KEY,
} = await import('./store')
const {digestOfHex} = await import('./record')

const BODY = 'a1b2c3'

const txRequest = (groupId = 'group-1'): SigningRequest => ({
  groupId,
  payload: {_tag: 'CardanoTx', bodyHex: BODY, networkId: 1},
})

const submitted: SigningSuccess = {_tag: 'TxSubmitted', txHash: 'hash-1', signedTxHex: 'ff'}

beforeEach(() => {
  backing.clear()
  warn.mockClear()
  failWrites = false
})

describe('recordSigningAudit', () => {
  it('persists a settled ceremony and reads it back', async () => {
    await recordSigningAudit({context: {purpose: 'send', origin: null}, requests: [txRequest()], results: [submitted]})
    const entries = await listSigningAudit()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      purpose: 'send',
      approval: 'reviewed',
      outcome: 'submitted',
      groupId: 'group-1',
      origin: null,
    })
  })

  it('never writes the signed bytes to storage', async () => {
    await recordSigningAudit({context: {purpose: 'send', origin: null}, requests: [txRequest()], results: [submitted]})
    const raw = backing.get(SIGNING_AUDIT_KEY) ?? ''
    expect(raw).not.toContain(BODY)
    expect(raw).toContain(digestOfHex(BODY))
  })

  it('accumulates entries newest-first', async () => {
    await recordSigningAudit({context: {purpose: 'send', origin: null}, requests: [txRequest()], results: [submitted]})
    await recordSigningAudit({
      context: {purpose: 'stake', origin: null},
      requests: [txRequest()],
      results: [submitted],
    })
    expect((await listSigningAudit()).map((e) => e.purpose)).toEqual(['stake', 'send'])
  })

  // The whole point of best-effort: a full disk must not turn a broadcast send into a failure.
  it('does not throw when the write fails, and warns instead', async () => {
    failWrites = true
    await expect(
      recordSigningAudit({context: {purpose: 'send', origin: null}, requests: [txRequest()], results: [submitted]}),
    ).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith(
      'Failed to record signing audit entry',
      expect.objectContaining({purpose: 'send'}),
    )
  })
})

describe('recordInfraSignature', () => {
  it('records an ID-slot signature with no wallet group', async () => {
    await recordInfraSignature({
      purpose: 'identity-login',
      payloadHex: 'deadbeef',
      signer: 'pnyx_id1x',
      signerKind: 'pnyx-id',
    })
    const [entry] = await listSigningAudit()
    expect(entry).toMatchObject({
      purpose: 'identity-login',
      approval: 'infra-exempt',
      groupId: null,
      accountIndex: null,
    })
  })

  it('does not store the signed payload', async () => {
    await recordInfraSignature({
      purpose: 'koios-register',
      payloadHex: 'deadbeef',
      signer: 'aabb',
      signerKind: 'cardano-address-hex',
    })
    expect(backing.get(SIGNING_AUDIT_KEY) ?? '').not.toContain('deadbeef')
  })
})

describe('listSigningAudit', () => {
  it('returns nothing when the key is absent', async () => {
    expect(await listSigningAudit()).toEqual([])
  })

  it('survives malformed JSON', async () => {
    backing.set(SIGNING_AUDIT_KEY, '{not json')
    expect(await listSigningAudit()).toEqual([])
    expect(warn).toHaveBeenCalled()
  })

  it('drops rows that fail the shape check and keeps the rest', async () => {
    const good = {
      id: 'a',
      at: 1,
      purpose: 'send',
      outcome: 'submitted',
      origin: null,
      groupId: 'g',
      accountIndex: 0,
      subjects: [{kind: 'transaction', bodyDigestHex: 'aa', signOnly: false}],
    }
    backing.set(SIGNING_AUDIT_KEY, JSON.stringify([good, {id: 'b'}, {...good, id: 'c', purpose: 'nonsense'}]))
    const entries = await listSigningAudit()
    expect(entries.map((e) => e.id)).toEqual(['a'])
  })
})

describe('parseAuditEntry', () => {
  const row = (overrides: Record<string, unknown> = {}) => ({
    id: 'a',
    at: 1,
    purpose: 'send',
    outcome: 'submitted',
    origin: 'https://app.example',
    groupId: 'g',
    accountIndex: 0,
    subjects: [{kind: 'transaction', bodyDigestHex: 'aa', signOnly: false}],
    ...overrides,
  })

  // The one classification a reader most needs to be true, so it is recomputed rather than trusted.
  it('recomputes the approval from the purpose, ignoring a tampered stored value', () => {
    const parsed = parseAuditEntry(row({approval: 'infra-exempt'}))
    expect(parsed?.approval).toBe('reviewed')
  })

  it('rejects an unknown purpose rather than coercing it', () => {
    expect(parseAuditEntry(row({purpose: 'exfiltrate'}))).toBeNull()
  })

  it('rejects an unknown outcome', () => {
    expect(parseAuditEntry(row({outcome: 'maybe'}))).toBeNull()
  })

  it('rejects the whole row when any subject is malformed', () => {
    expect(parseAuditEntry(row({subjects: [{kind: 'transaction'}]}))).toBeNull()
    expect(parseAuditEntry(row({subjects: [{kind: 'sideways'}]}))).toBeNull()
  })

  it('preserves a missing origin as null instead of inventing one', () => {
    expect(parseAuditEntry(row({origin: undefined}))?.origin).toBeNull()
    expect(parseAuditEntry(row({groupId: undefined}))?.groupId).toBeNull()
    expect(parseAuditEntry(row({accountIndex: undefined}))?.accountIndex).toBeNull()
  })

  it('rejects non-objects and non-entries', () => {
    expect(parseAuditEntry(null)).toBeNull()
    expect(parseAuditEntry('a')).toBeNull()
    expect(parseAuditEntry(row({subjects: 'nope'}))).toBeNull()
  })
})

describe('clearSigningAudit', () => {
  it('erases the log', async () => {
    await recordSigningAudit({context: {purpose: 'send', origin: null}, requests: [txRequest()], results: [submitted]})
    await clearSigningAudit()
    expect(await listSigningAudit()).toEqual([])
  })
})
