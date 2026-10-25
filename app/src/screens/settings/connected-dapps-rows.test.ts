import type {DappSession} from '@pnyx/dapp-connector'
import {describe, expect, it} from 'vitest'
import {buildConnectedDappRows, connectedAge, displayHost, expiresIn} from './connected-dapps-rows'

const NOW = 1_700_000_000_000
const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const session = (over: Partial<DappSession> = {}): DappSession => ({
  id: 'session-1',
  origin: 'https://app.example',
  chainType: 'cardano',
  groupId: 'group-1',
  accountIndex: 0,
  connectedAt: NOW - HOUR,
  expiresAt: NOW + 6 * DAY,
  ...over,
})

const NAMES = new Map([
  ['group-1', 'Night hacker'],
  ['group-2', 'Cold storage'],
])

describe('displayHost', () => {
  it('strips the scheme', () => {
    expect(displayHost('https://app.example')).toBe('app.example')
    expect(displayHost('http://localhost:3000')).toBe('localhost:3000')
  })

  it('strips a trailing slash', () => {
    expect(displayHost('https://app.example/')).toBe('app.example')
  })
})

describe('connectedAge', () => {
  it('uses minutes under an hour', () => {
    expect(connectedAge(NOW - 5 * MINUTE, NOW)).toEqual({value: -5, unit: 'minute'})
  })

  it('uses hours under a day', () => {
    expect(connectedAge(NOW - 3 * HOUR, NOW)).toEqual({value: -3, unit: 'hour'})
  })

  it('uses days beyond a day', () => {
    expect(connectedAge(NOW - 2 * DAY, NOW)).toEqual({value: -2, unit: 'day'})
  })

  it('clamps a future timestamp to now rather than reporting a negative age', () => {
    expect(connectedAge(NOW + HOUR, NOW)).toEqual({value: 0, unit: 'minute'})
  })

  it('crosses each boundary at the right point', () => {
    expect(connectedAge(NOW - (HOUR - 1), NOW).unit).toBe('minute')
    expect(connectedAge(NOW - HOUR, NOW).unit).toBe('hour')
    expect(connectedAge(NOW - (DAY - 1), NOW).unit).toBe('hour')
    expect(connectedAge(NOW - DAY, NOW).unit).toBe('day')
  })
})

describe('expiresIn', () => {
  it('reports never for an until-revoked grant', () => {
    expect(expiresIn(null, NOW)).toEqual({kind: 'never'})
  })

  it('counts down in the coarsest useful unit', () => {
    expect(expiresIn(NOW + 5 * MINUTE, NOW)).toEqual({kind: 'in', value: 5, unit: 'minute'})
    expect(expiresIn(NOW + 3 * HOUR, NOW)).toEqual({kind: 'in', value: 3, unit: 'hour'})
    expect(expiresIn(NOW + 6 * DAY, NOW)).toEqual({kind: 'in', value: 6, unit: 'day'})
  })

  it('rounds a countdown rather than flooring it', () => {
    // A 7-day grant a moment old must not read "in 6 days".
    expect(expiresIn(NOW + 7 * DAY - MINUTE, NOW)).toEqual({kind: 'in', value: 7, unit: 'day'})
    expect(expiresIn(NOW + 5 * DAY - 1, NOW)).toEqual({kind: 'in', value: 5, unit: 'day'})
  })

  it('promotes to the next unit instead of reporting its ceiling', () => {
    expect(expiresIn(NOW + DAY - MINUTE, NOW)).toEqual({kind: 'in', value: 1, unit: 'day'})
    expect(expiresIn(NOW + HOUR - 100, NOW)).toEqual({kind: 'in', value: 1, unit: 'hour'})
  })

  it('clamps an already-lapsed expiry to zero instead of counting backwards', () => {
    // The manager prunes expired rows, so this only shows under clock skew.
    expect(expiresIn(NOW - HOUR, NOW)).toEqual({kind: 'in', value: 0, unit: 'minute'})
  })
})

describe('buildConnectedDappRows', () => {
  it('resolves the wallet name from the group id', () => {
    const [row] = buildConnectedDappRows([session()], NAMES, NOW)
    expect(row).toMatchObject({
      host: 'app.example',
      walletName: 'Night hacker',
      chainType: 'cardano',
      accountIndex: 0,
    })
  })

  it('carries each grant its own expiry', () => {
    const rows = buildConnectedDappRows(
      [session({id: 'a', expiresAt: NOW + 2 * DAY}), session({id: 'b', expiresAt: null, connectedAt: NOW - 2 * HOUR})],
      NAMES,
      NOW,
    )
    expect(rows.find((r) => r.id === 'a')?.expiry).toEqual({kind: 'in', value: 2, unit: 'day'})
    expect(rows.find((r) => r.id === 'b')?.expiry).toEqual({kind: 'never'})
  })

  it('carries the account the grant is scoped to', () => {
    const [row] = buildConnectedDappRows([session({accountIndex: 3})], NAMES, NOW)
    expect(row?.accountIndex).toBe(3)
  })

  it('keeps a session whose wallet group is gone, with no name', () => {
    // The grant is real and must stay revocable — and never shows a placeholder.
    const [row] = buildConnectedDappRows([session({groupId: 'deleted'})], NAMES, NOW)
    expect(row?.walletName).toBeNull()
    expect(row?.host).toBe('app.example')
  })

  it('sorts newest grant first', () => {
    const rows = buildConnectedDappRows(
      [
        session({id: 'old', origin: 'https://old.example', connectedAt: NOW - 5 * HOUR}),
        session({id: 'new', origin: 'https://new.example', connectedAt: NOW - MINUTE}),
      ],
      NAMES,
      NOW,
    )
    expect(rows.map((r) => r.id)).toEqual(['new', 'old'])
  })

  it('does not mutate the input array', () => {
    const sessions = [session({id: 'a', connectedAt: NOW - HOUR}), session({id: 'b', connectedAt: NOW - 2 * HOUR})]
    buildConnectedDappRows(sessions, NAMES, NOW)
    expect(sessions.map((s) => s.id)).toEqual(['a', 'b'])
  })

  it('returns nothing for no sessions', () => {
    expect(buildConnectedDappRows([], NAMES, NOW)).toEqual([])
  })
})
