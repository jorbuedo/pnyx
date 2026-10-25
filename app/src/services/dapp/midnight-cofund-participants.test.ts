// The authority boundary of Midnight co-funding: only wallets the person granted may contribute, and
// the wallet the call is addressed to must be one of them.
import {describe, expect, it} from 'vitest'
import {type GrantedMidnightScope, resolveCoFundParticipants} from './midnight-cofund-participants'

const scope = (key: string, groupId: string, accountIndex: number, name: string): GrantedMidnightScope => ({
  key,
  groupId,
  accountIndex,
  name,
})

const granted = new Map([
  ['g1:0', scope('g1:0', 'g1', 0, 'Abandon 12')],
  ['g2:0', scope('g2:0', 'g2', 0, 'Abandon 15')],
])

const src = (key: string, pledge: bigint) => ({scope: key, pledge})

describe('resolveCoFundParticipants', () => {
  it('resolves each source to the wallet and account the person granted', () => {
    const out = resolveCoFundParticipants([src('g1:0', 2n), src('g2:0', 4n)], granted, 'g1:0')
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.participants).toEqual([
      {groupId: 'g1', accountIndex: 0, scopeKey: 'g1:0', name: 'Abandon 12', pledge: 2n},
      {groupId: 'g2', accountIndex: 0, scopeKey: 'g2:0', name: 'Abandon 15', pledge: 4n},
    ])
  })

  // ⚠️ The rule the whole module exists for. An agent naming an ungranted wallet must not reach a vault.
  it('refuses a scope the person did not grant, and names what is granted', () => {
    const out = resolveCoFundParticipants([src('g1:0', 2n), src('g9:0', 4n)], granted, 'g1:0')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.message).toContain("'g9:0'")
    expect(out.message).toContain('g1:0, g2:0')
  })

  // The account index travels from the grant, never from the call — the implicit-index bug this app has
  // paid for six times cannot be reintroduced from an agent's arguments.
  it('takes the account index from the grant, not from the source', () => {
    const other = new Map([['g1:3', scope('g1:3', 'g1', 3, 'Abandon 12 · account 4')]])
    const out = resolveCoFundParticipants([src('g1:3', 1n)], other, 'g1:3')
    expect(out.ok && out.participants[0]?.accountIndex).toBe(3)
  })

  it('refuses when the addressed wallet is not one of the contributors', () => {
    const out = resolveCoFundParticipants([src('g2:0', 4n)], granted, 'g1:0')
    expect(out.ok).toBe(false)
    if (out.ok) return
    expect(out.message).toContain("'g1:0'")
    expect(out.message).toContain('Address the call to a different scope')
  })

  it('refuses an empty source list rather than composing nothing', () => {
    expect(resolveCoFundParticipants([], granted, 'g1:0').ok).toBe(false)
  })
})
