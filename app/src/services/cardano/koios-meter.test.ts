import type {RequestBudget} from '@evolution-sdk/evolution'
import {describe, expect, it} from 'vitest'
import {dropBefore, emptyMeter, type MeteredRequest, meter, pathCounts, tally} from './koios-meter'

const req = (at: number, path: string, status = 200, waitedMs = 0): MeteredRequest => ({at, path, status, waitedMs})

const report = (over: Partial<RequestBudget.RequestReport> = {}): RequestBudget.RequestReport => ({
  host: 'https://api.koios.rest',
  path: '/api/v1/address_utxos',
  method: 'POST',
  status: 200,
  waitedMs: 0,
  ms: 120,
  inWindow: 1,
  ...over,
})

const SHED =
  '<html><body><h1>429 Too Many Requests</h1>\nYou have sent too many requests in a given amount of time.\n</body></html>\n'

describe('tally', () => {
  it('counts only what falls inside the window', () => {
    const requests = [req(1_000, '/tip'), req(5_000, '/tip'), req(9_000, '/tip')]
    expect(tally(requests, 5_000).total).toBe(2)
  })

  it('names the busiest paths first, so a report says what was spending', () => {
    const requests = [
      req(1, '/address_utxos'),
      req(2, '/address_utxos'),
      req(3, '/address_utxos'),
      req(4, '/tip'),
      req(5, '/account_info'),
      req(6, '/account_info'),
    ]
    expect(pathCounts(tally(requests, 0))).toEqual({'/address_utxos': 3, '/account_info': 2, '/tip': 1})
  })

  it('separates refusals from requests the pacer merely held back', () => {
    const t = tally([req(1, '/tip', 429), req(2, '/tip', 200, 340), req(3, '/tip')], 0)
    expect(t).toMatchObject({total: 3, refused: 1, held: 1})
  })
})

describe('dropBefore', () => {
  it('forgets what has aged out, so the history stays bounded', () => {
    expect(dropBefore([req(1_000, '/tip'), req(9_000, '/tip')], 5_000)).toEqual([req(9_000, '/tip')])
  })
})

describe('meter', () => {
  it('warns on a refusal, carrying what we had spent when it arrived', () => {
    // Twenty calls in the four seconds before the refusal — the shape of the gap
    // scan that was refused. The whole point of the line is that these numbers are
    // in it: 21 requests against a 90-per-10s budget did not earn a 429.
    let state = emptyMeter()
    for (let i = 0; i < 20; i++) state = meter(state, report(), 100_000 + i * 200).state
    const {lines} = meter(state, report({status: 429, refusalBody: SHED}), 104_000)
    expect(lines).toHaveLength(1)
    expect(lines[0]?.level).toBe('warn')
    expect(lines[0]?.data).toMatchObject({
      kind: 'shed',
      inLast10s: 21,
      sinceLaunch: 21,
      paths: {'/api/v1/address_utxos': 21},
    })
  })

  it('does not mistake a non-429 for a refusal', () => {
    const {lines} = meter({...emptyMeter(), volumeLoggedAt: 100_000}, report({status: 500}), 100_100)
    expect(lines).toEqual([])
  })

  it('says when the pacer starts holding requests back', () => {
    const {lines} = meter({...emptyMeter(), volumeLoggedAt: 100_000}, report({waitedMs: 420, inWindow: 90}), 100_100)
    expect(lines[0]?.level).toBe('debug')
    expect(lines[0]?.data).toMatchObject({waitedMs: 420, inWindow: 90})
  })

  it('holds the saturation line to one per interval rather than one per request', () => {
    const first = meter(emptyMeter(), report({waitedMs: 100}), 100_000)
    expect(first.lines).toHaveLength(1)
    const second = meter(first.state, report({waitedMs: 100}), 100_500)
    expect(second.lines).toEqual([])
    const later = meter(second.state, report({waitedMs: 100}), 140_000)
    expect(later.lines).toHaveLength(1)
  })

  it('reports volume periodically, so a quiet log still says what was sent', () => {
    const first = meter(emptyMeter(), report(), 100_000)
    expect(first.lines[0]?.message).toBe('Koios request volume')
    const soon = meter(first.state, report(), 100_100)
    expect(soon.lines).toEqual([])
    const later = meter(soon.state, report(), 161_000)
    expect(later.lines[0]?.message).toBe('Koios request volume')
    expect(later.lines[0]?.data).toMatchObject({sinceLaunch: 3})
  })

  it('counts every request since launch, past the kept history', () => {
    const first = meter(emptyMeter(), report(), 100_000)
    // An hour later the request above is long dropped from the window…
    const later = meter(first.state, report(), 3_700_000)
    expect(later.state.requests).toHaveLength(1)
    // …but the day's spend is not, because that is the number a daily quota is against.
    expect(later.state.sinceLaunch).toBe(2)
  })
})

describe('the path cap says what it dropped', () => {
  // ⚠️ The regression this exists for. Twice on 2026-09-08 an absent `/credential_utxos` in a
  // breakdown was read as proof the UTxO fetch had never run — it was the top-5 cut hiding it.
  // A bounded report that does not say it is bounded invites exactly that reading.
  it('counts the paths and requests the cap left out', () => {
    const now = 1_000_000
    const requests = [
      ...Array.from({length: 5}, (_, i) => ({path: `/busy${i}`, at: now, status: 200, waitedMs: 0})),
      {path: '/credential_utxos', at: now, status: 200, waitedMs: 0},
      {path: '/quiet', at: now, status: 200, waitedMs: 0},
    ]
    const t = tally(requests, now - 1)

    expect(t.byPath).toHaveLength(5)
    expect(t.otherPaths).toBe(2)
    expect(t.otherRequests).toBe(2)
    // The listed counts plus what was dropped must reconcile to the total, or the report is
    // still lying about the window it describes.
    expect(t.byPath.reduce((n, p) => n + p.count, 0) + t.otherRequests).toBe(t.total)
  })

  it('reports nothing dropped when every path fits', () => {
    const now = 1_000_000
    const t = tally([{path: '/tip', at: now, status: 200, waitedMs: 0}], now - 1)

    expect(t.otherPaths).toBe(0)
    expect(t.otherRequests).toBe(0)
  })
})
