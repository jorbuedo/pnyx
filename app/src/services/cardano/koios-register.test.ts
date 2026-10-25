/**
 * The two decisions Koios registration got wrong in the field.
 *
 * Both are pure and exported for exactly that reason: the failure they cover is a *misreading*,
 * and a test of a misreading must not need a network or a device to reproduce it.
 */

import {describe, expect, it} from 'vitest'
import {koiosAbsenceHolds, readKoiosBody} from './koios-register'

/** What `api.koios.rest` actually returns for an unrouted path, verified 2026-09-30. */
const QUERY_NOT_FOUND = 'Query not Found! Please verify syntax referring to examples from https://api.koios.rest\n'

describe('readKoiosBody', () => {
  // The whole point. Parsing this unconditionally logged `SyntaxError: Unexpected character: Q`
  // — the letter Q, from the word "Query" — where the fact is that the endpoint is gone.
  it('does not treat a 404 HTML page as malformed JSON', () => {
    const read = readKoiosBody('text/html', QUERY_NOT_FOUND)
    expect(read.malformed).toBeNull()
    expect(read.json).toBeNull()
    expect(read.body).toContain('Query not Found!')
  })

  it('parses a real JSON body', () => {
    const read = readKoiosBody('application/json; charset=utf-8', '{"data":{"token":"jwt"}}')
    expect(read.malformed).toBeNull()
    expect(read.json).toEqual({data: {token: 'jwt'}})
  })

  it('parses JSON that arrives without a content-type', () => {
    expect(readKoiosBody(null, '  {"success":true}').json).toEqual({success: true})
    expect(readKoiosBody(null, '[1,2]').json).toEqual([1, 2])
  })

  // A body that CLAIMS json and is not is a genuine server fault, and still worth a warning —
  // the fix narrows what counts as one, it does not stop reporting it.
  it('still reports a malformed body that claimed to be JSON', () => {
    const read = readKoiosBody('application/json', '{"truncated":')
    expect(read.malformed).toContain('SyntaxError')
    expect(read.json).toBeNull()
  })

  it('keeps the snippet short and on one line, so a log stays readable', () => {
    const read = readKoiosBody('text/html', `${'x'.repeat(400)}\n\n   y`)
    expect(read.body.length).toBeLessThanOrEqual(160)
    expect(read.body).not.toContain('\n')
  })
})

describe('koiosAbsenceHolds', () => {
  const NOW = Date.parse('2026-09-30T12:00:00Z')
  const hours = (n: number) => n * 3_600_000

  it('holds inside the window and lapses after it', () => {
    expect(koiosAbsenceHolds(String(NOW - hours(1)), NOW)).toBe(true)
    expect(koiosAbsenceHolds(String(NOW - hours(11)), NOW)).toBe(true)
    expect(koiosAbsenceHolds(String(NOW - hours(13)), NOW)).toBe(false)
  })

  // "We never recorded one" and "we cannot read what we recorded" must both mean ASK. Reading
  // either as absence would mute registration permanently on a corrupt value.
  it('does not hold when nothing was recorded', () => {
    expect(koiosAbsenceHolds(null, NOW)).toBe(false)
  })

  it('does not hold on an unparseable marker', () => {
    expect(koiosAbsenceHolds('not-a-number', NOW)).toBe(false)
    expect(koiosAbsenceHolds('', NOW)).toBe(false)
  })

  // A marker from the future is a clock change, not a fresh 404 — treating it as current would
  // mute registration until the device caught up.
  it('does not hold on a marker dated in the future', () => {
    expect(koiosAbsenceHolds(String(NOW + hours(2)), NOW)).toBe(false)
  })
})
