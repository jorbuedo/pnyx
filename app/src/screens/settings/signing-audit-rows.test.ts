import {describe, expect, it} from 'vitest'
import type {SigningAuditEntry} from '../../services/signing-audit'
import {
  buildSigningAuditRows,
  displayOriginHost,
  groupSigningAuditRows,
  signedAge,
  summariseFailureReason,
} from './signing-audit-rows'

const NOW = 1_700_000_000_000

const entry = (overrides: Partial<SigningAuditEntry> = {}): SigningAuditEntry => ({
  id: 'e1',
  at: NOW,
  purpose: 'send',
  approval: 'reviewed',
  outcome: 'submitted',
  origin: null,
  groupId: 'group-1',
  accountIndex: 0,
  subjects: [{kind: 'transaction', txHash: 'hash-1', bodyDigestHex: 'aa', signOnly: false}],
  ...overrides,
})

const names = new Map([['group-1', 'My wallet']])

describe('displayOriginHost', () => {
  it('strips the scheme and a trailing slash', () => {
    expect(displayOriginHost('https://app.example/')).toBe('app.example')
    expect(displayOriginHost('http://localhost:3000')).toBe('localhost:3000')
  })

  // An origin is dApp-chosen: it must render as something, not collapse to empty.
  it('falls back to the raw value when stripping would empty it', () => {
    expect(displayOriginHost('https://')).toBe('https://')
  })
})

describe('signedAge', () => {
  it('is a past-facing offset in the coarsest informative unit', () => {
    expect(signedAge(NOW - 5 * 60_000, NOW)).toEqual({value: -5, unit: 'minute'})
    expect(signedAge(NOW - 3 * 3_600_000, NOW)).toEqual({value: -3, unit: 'hour'})
    expect(signedAge(NOW - 2 * 86_400_000, NOW)).toEqual({value: -2, unit: 'day'})
  })

  // Flooring, so a span just short of the next unit reports the lower one rather than
  // rounding up — "59 minutes ago", not "1 hour ago".
  it('floors at each unit boundary', () => {
    expect(signedAge(NOW - 59.9 * 60_000, NOW)).toEqual({value: -59, unit: 'minute'})
    expect(signedAge(NOW - 23.9 * 3_600_000, NOW)).toEqual({value: -23, unit: 'hour'})
    expect(signedAge(NOW - 60 * 60_000, NOW)).toEqual({value: -1, unit: 'hour'})
    expect(signedAge(NOW - 24 * 3_600_000, NOW)).toEqual({value: -1, unit: 'day'})
  })

  it('clamps a future timestamp to now instead of counting up', () => {
    expect(signedAge(NOW + 60_000, NOW)).toEqual({value: 0, unit: 'minute'})
  })
})

describe('buildSigningAuditRows', () => {
  it('names the signing wallet and its account', () => {
    const [row] = buildSigningAuditRows([entry()], names, NOW)
    expect(row?.actor).toEqual({kind: 'wallet', name: 'My wallet', accountIndex: 0})
    expect(row?.txHashes).toEqual(['hash-1'])
  })

  // The signature happened; deleting the wallet does not un-happen it.
  it('keeps a row whose wallet group is gone, without inventing a name', () => {
    const [row] = buildSigningAuditRows([entry({groupId: 'vanished'})], names, NOW)
    expect(row?.actor).toEqual({kind: 'wallet', name: null, accountIndex: 0})
  })

  it('renders an ID-slot signature as the identity, not a nameless wallet', () => {
    const [row] = buildSigningAuditRows(
      [
        entry({
          purpose: 'identity-login',
          approval: 'infra-exempt',
          groupId: null,
          accountIndex: null,
          outcome: 'signed',
          subjects: [
            {kind: 'message', payloadDigestHex: 'dd', payloadByteLength: 8, signer: 'x', signerKind: 'mn-addr'},
          ],
        }),
      ],
      names,
      NOW,
    )
    expect(row?.actor).toEqual({kind: 'identity'})
    expect(row?.wasUnreviewed).toBe(true)
    expect(row?.messageDigests).toEqual(['dd'])
    expect(row?.txHashes).toEqual([])
  })

  it('sorts newest first regardless of stored order', () => {
    const rows = buildSigningAuditRows([entry({id: 'old', at: NOW - 10_000}), entry({id: 'new', at: NOW})], names, NOW)
    expect(rows.map((r) => r.id)).toEqual(['new', 'old'])
  })

  // The discrepancy worth seeing: a two-leg ceremony where only one leg reached the chain.
  it('reports fewer tx hashes than legs when a chain partially landed', () => {
    const [row] = buildSigningAuditRows(
      [
        entry({
          outcome: 'failed',
          failureReason: 'All inputs are spent',
          subjects: [
            {kind: 'transaction', txHash: 'hash-1', bodyDigestHex: 'aa', signOnly: false},
            {kind: 'transaction', bodyDigestHex: 'bb', signOnly: false},
          ],
        }),
      ],
      names,
      NOW,
    )
    expect(row?.legCount).toBe(2)
    expect(row?.txHashes).toEqual(['hash-1'])
    expect(row?.failureReason).toBe('All inputs are spent')
  })

  it('strips the scheme off a dApp origin and keeps in-app actions origin-less', () => {
    const [dapp] = buildSigningAuditRows([entry({purpose: 'dapp-tx', origin: 'https://app.example'})], names, NOW)
    expect(dapp?.originHost).toBe('app.example')
    const [inApp] = buildSigningAuditRows([entry()], names, NOW)
    expect(inApp?.originHost).toBeNull()
  })
})

describe('groupSigningAuditRows', () => {
  const rows = () =>
    buildSigningAuditRows(
      [
        entry(),
        entry({id: 'e2', purpose: 'identity-login', approval: 'infra-exempt', groupId: null, accountIndex: null}),
        entry({id: 'e3', purpose: 'koios-register', approval: 'infra-exempt', groupId: null, accountIndex: null}),
      ],
      names,
      NOW,
    )

  // The reason this is grouped rather than counted: an alarming aggregate presented
  // routine ID-slot signatures as evidence of compromise.
  it('separates what the user confirmed from what the app signed by itself', () => {
    const {confirmed, automatic} = groupSigningAuditRows(rows())
    expect(confirmed.map((r) => r.id)).toEqual(['e1'])
    expect(automatic.map((r) => r.id)).toEqual(['e2', 'e3'])
  })

  it('puts every row in exactly one group', () => {
    const all = rows()
    const {confirmed, automatic} = groupSigningAuditRows(all)
    expect(confirmed.length + automatic.length).toBe(all.length)
    expect(confirmed.filter((r) => automatic.includes(r))).toEqual([])
  })

  // An empty group must not render, so it has to actually come back empty.
  it('returns an empty group rather than a placeholder when a kind is absent', () => {
    const {confirmed, automatic} = groupSigningAuditRows(buildSigningAuditRows([entry()], names, NOW))
    expect(confirmed).toHaveLength(1)
    expect(automatic).toEqual([])
  })

  it('preserves newest-first order within each group', () => {
    const {automatic} = groupSigningAuditRows(
      buildSigningAuditRows(
        [
          entry({id: 'older', at: NOW - 60_000, approval: 'infra-exempt', purpose: 'identity-login', groupId: null}),
          entry({id: 'newer', at: NOW, approval: 'infra-exempt', purpose: 'identity-login', groupId: null}),
        ],
        names,
        NOW,
      ),
    )
    expect(automatic.map((r) => r.id)).toEqual(['newer', 'older'])
  })
})

describe('summariseFailureReason', () => {
  it('leaves a short reason alone', () => {
    expect(summariseFailureReason('Insufficient collateral')).toBe('Insufficient collateral')
  })

  // A node rejection arrives as pretty-printed JSON; on one line it stops eating the whole card.
  it('collapses newlines and runs of whitespace into single spaces', () => {
    expect(summariseFailureReason('{\n  "code": 2,\n  "message":   "bad inputs"\n}')).toBe(
      '{ "code": 2, "message": "bad inputs" }',
    )
  })

  it('trims the ends rather than leaving the collapse visible', () => {
    expect(summariseFailureReason('\n  ValueNotConservedUTxO  \n')).toBe('ValueNotConservedUTxO')
  })

  it('cuts at the limit and marks that it did', () => {
    const summary = summariseFailureReason('x'.repeat(400), 20)
    expect(summary).toBe(`${'x'.repeat(20)}\u2026`)
  })

  // The ellipsis has to be the only thing after the cut — a trailing space before it reads as a gap.
  it('does not leave a space before the ellipsis', () => {
    expect(summariseFailureReason('ledger error occurred here', 13)).toBe('ledger error\u2026')
  })

  it('does not truncate a reason that is exactly the limit', () => {
    expect(summariseFailureReason('y'.repeat(30), 30)).toBe('y'.repeat(30))
  })
})
