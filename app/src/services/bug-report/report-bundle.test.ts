import type {LogEntry} from '@pnyx/logger'
import {describe, expect, it} from 'vitest'
import {
  buildReportManifest,
  decideAttachments,
  descriptionIsSubmittable,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS,
  MAX_DESCRIPTION_CHARS,
  MAX_SINGLE_ATTACHMENT_BYTES,
  type ReportAttachment,
  type ReportContext,
} from './report-bundle'

const file = (over: Partial<ReportAttachment> = {}): ReportAttachment => ({
  name: 'shot.png',
  mimeType: 'image/png',
  sizeBytes: 1024,
  uri: 'file:///shot.png',
  ...over,
})

const context: ReportContext = {
  appVersion: '1.2.3',
  appEnv: 'dev',
  platform: 'android',
  osVersion: '15',
  network: 'mainnet',
  identity: 'pnyx_id1abc',
  createdAtIso: '2026-09-08T12:00:00.000Z',
}

const entry = (i: number): LogEntry => ({
  id: `e${i}`,
  level: 'debug',
  message: `line ${i}`,
  metadata: {},
  timestamp: 1_000 + i,
})

describe('decideAttachments', () => {
  it('accepts files that fit and reports the running total', () => {
    const decision = decideAttachments([], [file({sizeBytes: 10}), file({sizeBytes: 20})])

    expect(decision.accepted).toHaveLength(2)
    expect(decision.acceptedBytes).toBe(30)
    expect(decision.rejected).toEqual([])
  })

  it('counts what is already attached, so a second pick cannot re-spend the budget', () => {
    const decision = decideAttachments([file({sizeBytes: MAX_ATTACHMENT_BYTES - 10})], [file({sizeBytes: 100})])

    expect(decision.accepted).toHaveLength(1)
    expect(decision.rejected[0]?.reason).toBe('would-exceed-budget')
  })

  it('refuses one oversized file without blaming the budget', () => {
    // The distinction is the whole point: "this file is too big" and "you are out of room"
    // ask the user for different things.
    const decision = decideAttachments([], [file({sizeBytes: MAX_SINGLE_ATTACHMENT_BYTES + 1})])

    expect(decision.rejected[0]?.reason).toBe('single-too-large')
  })

  it('caps the count', () => {
    const many = Array.from({length: MAX_ATTACHMENTS + 2}, (_, i) => file({name: `f${i}.png`, sizeBytes: 1}))
    const decision = decideAttachments([], many)

    expect(decision.accepted).toHaveLength(MAX_ATTACHMENTS)
    expect(decision.rejected.map((r) => r.reason)).toEqual(['too-many', 'too-many'])
  })

  // ⚠️ An unknown size assumed small becomes a failed upload after the user has waited, and
  // the failure arrives with nothing to explain it.
  it('refuses a file whose size the picker could not report', () => {
    expect(decideAttachments([], [file({sizeBytes: Number.NaN})]).rejected[0]?.reason).toBe('unknown-size')
    expect(decideAttachments([], [file({sizeBytes: -1})]).rejected[0]?.reason).toBe('unknown-size')
  })

  it('keeps the caller order, so a file the user saw accepted stays accepted', () => {
    // Both under the single-file cap, so the only rule that can bite is the shared budget —
    // otherwise this would pass for the wrong reason.
    const first = file({name: 'first.png', sizeBytes: MAX_SINGLE_ATTACHMENT_BYTES})
    const second = file({name: 'second.png', sizeBytes: MAX_ATTACHMENT_BYTES - MAX_SINGLE_ATTACHMENT_BYTES + 1})
    expect(second.sizeBytes).toBeLessThanOrEqual(MAX_SINGLE_ATTACHMENT_BYTES)
    const decision = decideAttachments([], [first, second])

    expect(decision.accepted.map((a) => a.name)).toEqual(['first.png'])
    expect(decision.rejected.map((r) => r.attachment.name)).toEqual(['second.png'])
    expect(decision.rejected[0]?.reason).toBe('would-exceed-budget')
  })
})

describe('buildReportManifest', () => {
  it('carries the description verbatim, whitespace included', () => {
    // The description is prose the user chose to send. Trimming or normalising it here would
    // quietly edit their words, and the repo's password policy exists because that habit
    // costs more than it saves.
    const manifest = buildReportManifest({
      description: '  it broke\n\n  after tapping send  ',
      context,
      logs: [],
      attachments: [],
      trailCapacity: 1000,
    })

    expect(manifest.description).toBe('  it broke\n\n  after tapping send  ')
  })

  // ⚠️ This test used to assert the manifest carried attachment metadata *without* contents, which
  // is how the defect shipped: the bytes were never read, and the assertion that they were absent
  // read as a privacy rule rather than the missing feature it was. Report `1ebc5ac0` (2026-09-09)
  // carried a 177 KB screenshot and stored 41 KB of JSON with no image in it.
  it('carries each attachment’s bytes, and never its local uri', () => {
    const manifest = buildReportManifest({
      description: 'x',
      context,
      logs: [],
      attachments: [{name: 'a.png', mimeType: 'image/png', sizeBytes: 7, content: 'AAECAwQFBg==', readError: null}],
      trailCapacity: 1000,
    })

    expect(manifest.attachments).toEqual([
      {name: 'a.png', mimeType: 'image/png', sizeBytes: 7, content: 'AAECAwQFBg==', readError: null},
    ])
    // The uri is a path on the reporter's device and has no business in a stored report.
    expect(JSON.stringify(manifest)).not.toContain('file:///')
  })

  // An unreadable file must stay visible as a file we failed to open, rather than vanishing into
  // the same empty list a report with no attachments produces.
  it('keeps an unreadable attachment as an entry carrying its reason', () => {
    const manifest = buildReportManifest({
      description: 'x',
      context,
      logs: [],
      attachments: [{name: 'gone.mp4', mimeType: 'video/mp4', sizeBytes: 900, content: null, readError: 'ENOENT'}],
      trailCapacity: 1000,
    })

    expect(manifest.attachments).toHaveLength(1)
    expect(manifest.attachments[0]?.content).toBeNull()
    expect(manifest.attachments[0]?.readError).toBe('ENOENT')
  })

  // A trail at capacity has been dropping its oldest line since it filled, so the report does
  // not begin where the session did. A reader who does not know that trusts the first line.
  it('flags a full trail as truncated', () => {
    const logs = Array.from({length: 10}, (_, i) => entry(i))

    expect(
      buildReportManifest({description: 'x', context, logs, attachments: [], trailCapacity: 10}).logsTruncated,
    ).toBe(true)
    expect(
      buildReportManifest({description: 'x', context, logs, attachments: [], trailCapacity: 11}).logsTruncated,
    ).toBe(false)
  })

  it('keeps a null identity as null rather than a placeholder', () => {
    const manifest = buildReportManifest({
      description: 'x',
      context: {...context, identity: null},
      logs: [],
      attachments: [],
      trailCapacity: 1000,
    })

    expect(manifest.context.identity).toBeNull()
  })
})

describe('descriptionIsSubmittable', () => {
  it('needs something more than whitespace', () => {
    expect(descriptionIsSubmittable('')).toBe(false)
    expect(descriptionIsSubmittable('   \n\t ')).toBe(false)
    expect(descriptionIsSubmittable('it broke')).toBe(true)
  })

  it('measures the length the user typed, not the trimmed one', () => {
    // Whitespace counts toward the cap because whitespace is what gets stored.
    expect(descriptionIsSubmittable(`x${' '.repeat(MAX_DESCRIPTION_CHARS)}`)).toBe(false)
    expect(descriptionIsSubmittable('x'.repeat(MAX_DESCRIPTION_CHARS))).toBe(true)
  })
})
