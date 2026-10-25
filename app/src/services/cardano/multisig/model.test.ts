import {XpubHex} from '@evolution-sdk/review/Brands'
import {Address, Keys} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {paymentKeyHashAt} from './derive'
import {deriveOwnAccountXpub, quorumStatusOf, signedTagsAt, validateSharedWallet, withTags} from './model'
import {flatTemplate, type ScriptTemplate, tagAt} from './template'
import type {CoSignerRef, SharedWallet} from './types'

const MNEMONIC_A = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const MNEMONIC_B = 'test walk nut penalty hip pave soap entry language right filter choice'

const run = <A>(eff: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)

const xpubOf = (mnemonic: string, account = 0) =>
  Keys.rootKeyFromMnemonic(mnemonic).pipe(Effect.flatMap((root) => deriveOwnAccountXpub(root, account)))

let A = ''
let B = ''
let C = ''

beforeAll(async () => {
  A = await run(xpubOf(MNEMONIC_A))
  B = await run(xpubOf(MNEMONIC_B))
  C = await run(xpubOf(MNEMONIC_B, 1))
})

const roster = (): readonly CoSignerRef[] =>
  withTags([
    {name: 'Alice', accountXpubHex: XpubHex(A), isSelf: true},
    {name: 'Bob', accountXpubHex: XpubHex(B)},
    {name: 'Carol', accountXpubHex: XpubHex(C)},
  ])

const wallet = (template?: ScriptTemplate): SharedWallet => {
  const coSigners = roster()
  const t =
    template ??
    flatTemplate(
      {kind: 'atLeast', n: 2},
      coSigners.map((c) => c.tag),
    )
  return {
    id: 'w1',
    name: 'Treasury',
    coSigners,
    paymentTemplate: t,
    delegationTemplate: t,
    network: Address.Network.Testnet,
    accountIndex: 0,
    createdAt: '2026-08-08T00:00:00.000Z',
  }
}

describe('deriveOwnAccountXpub', () => {
  it('produces a 64-byte account xpub', async () => {
    expect(A).toHaveLength(128)
  })

  it('differs per account index — a second account is a distinct co-signer', async () => {
    expect(B).not.toBe(C)
  })
})

describe('withTags', () => {
  it('assigns cosigner#N by position', () => {
    expect(roster().map((c) => c.tag)).toEqual([tagAt(0), tagAt(1), tagAt(2)])
  })
})

describe('validateSharedWallet', () => {
  it('accepts a well-formed wallet', () => {
    const w = wallet()
    expect(validateSharedWallet(w)).toEqual([])
  })

  it('rejects two co-signers backed by the same key', () => {
    // A "2-of-3" where two entries share a key is really a 2-of-2, and the
    // duplicate holder can meet the quorum alone.
    const coSigners = withTags([
      {name: 'Alice', accountXpubHex: XpubHex(A)},
      {name: 'Alice again', accountXpubHex: XpubHex(A)},
      {name: 'Bob', accountXpubHex: XpubHex(B)},
    ])
    const t = flatTemplate(
      {kind: 'atLeast', n: 2},
      coSigners.map((c) => c.tag),
    )
    expect(validateSharedWallet({coSigners, paymentTemplate: t, delegationTemplate: t})).toContainEqual({
      kind: 'duplicate-xpub',
      name: 'Alice again',
    })
  })

  it('surfaces template problems from both templates', () => {
    const coSigners = roster()
    const bad = flatTemplate(
      {kind: 'atLeast', n: 9},
      coSigners.map((c) => c.tag),
    )
    const problems = validateSharedWallet({coSigners, paymentTemplate: bad, delegationTemplate: bad})
    expect(problems.filter((p) => p.kind === 'threshold-out-of-range')).toHaveLength(2)
  })
})

describe('quorumStatusOf', () => {
  it('reports progress below quorum', () => {
    const status = quorumStatusOf(wallet(), [tagAt(0)])
    expect(status).toMatchObject({signed: 1, required: 2, total: 3, meetsQuorum: false})
    expect(status.missingTags).toEqual([tagAt(1), tagAt(2)])
  })

  it('meets quorum at the threshold', () => {
    expect(quorumStatusOf(wallet(), [tagAt(0), tagAt(2)])).toMatchObject({signed: 2, meetsQuorum: true})
  })

  it('judges a nested template structurally, not by count', () => {
    // all [a, any [b, c]] — b and c together are two signatures and still unmet.
    const nested: ScriptTemplate = {
      kind: 'all',
      scripts: [
        {kind: 'cosigner', tag: tagAt(0)},
        {
          kind: 'any',
          scripts: [
            {kind: 'cosigner', tag: tagAt(1)},
            {kind: 'cosigner', tag: tagAt(2)},
          ],
        },
      ],
    }
    expect(quorumStatusOf(wallet(nested), [tagAt(1), tagAt(2)]).meetsQuorum).toBe(false)
    expect(quorumStatusOf(wallet(nested), [tagAt(0), tagAt(1)]).meetsQuorum).toBe(true)
  })

  it('ignores a signature from outside the roster', () => {
    expect(quorumStatusOf(wallet(), [tagAt(0), 'cosigner#99']).signed).toBe(1)
  })
})

describe('signedTagsAt', () => {
  it('maps witness key hashes back to co-signer tags at the spending index', async () => {
    const w = wallet()
    const hashAlice = await run(paymentKeyHashAt(XpubHex(A), 4))
    const tags = await run(signedTagsAt(w, 4, [hashAlice.toUpperCase()]))
    expect(tags).toEqual([tagAt(0)])
  })

  it('does not match a hash derived at a different index', async () => {
    // The same co-signer has a different key at every index, so a witness only
    // counts against the index the transaction actually spent from.
    const w = wallet()
    const hashAtFour = await run(paymentKeyHashAt(XpubHex(A), 4))
    expect(await run(signedTagsAt(w, 5, [hashAtFour]))).toEqual([])
  })

  it('ignores unrelated witnesses', async () => {
    expect(await run(signedTagsAt(wallet(), 0, ['ff'.repeat(28)]))).toEqual([])
  })
})
