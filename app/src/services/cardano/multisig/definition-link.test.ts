import {XpubHex} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {parseBrandLink} from '@pnyx/links'
import {Either} from 'effect'
import {describe, expect, it} from 'vitest'
import {
  buildDefinitionLink,
  definitionFitsQr,
  definitionOfAction,
  packDefinition,
  unpackDefinition,
} from './definition-link'
import type {SharedWallet} from './types'

const KEY_A = 'a'.repeat(128)
const KEY_B = 'b'.repeat(128)

const wallet = (over: Partial<SharedWallet> = {}): SharedWallet => ({
  id: 'w1',
  name: 'Rent pot',
  coSigners: [
    {tag: 'cosigner#0', name: 'Jordi', accountXpubHex: XpubHex(KEY_A), isSelf: true},
    {tag: 'cosigner#1', name: 'Alex', accountXpubHex: XpubHex(KEY_B)},
  ],
  paymentTemplate: {
    kind: 'all',
    scripts: [
      {kind: 'cosigner', tag: 'cosigner#0'},
      {kind: 'cosigner', tag: 'cosigner#1'},
    ],
  },
  delegationTemplate: {
    kind: 'all',
    scripts: [
      {kind: 'cosigner', tag: 'cosigner#0'},
      {kind: 'cosigner', tag: 'cosigner#1'},
    ],
  },
  network: Address.Network.Mainnet,
  accountIndex: 0,
  selfGroupId: 'group-local',
  createdAt: '2026-09-04T00:00:00.000Z',
  registration: {status: 'published', txHash: 'ff'.repeat(32)},
  ...over,
})

/** The packed payload as a plain object, so a test can corrupt one field. */
const repack = (mutate: (wire: Record<string, unknown>) => void): string => {
  const packed = packDefinition(wallet())
  const json = JSON.parse(Buffer.from(packed, 'base64url').toString('utf8'))
  mutate(json)
  return Buffer.from(JSON.stringify(json), 'utf8').toString('base64url')
}

describe('packDefinition / unpackDefinition', () => {
  it('round-trips the roster, both templates, network and account index', () => {
    const back = unpackDefinition(packDefinition(wallet()))
    expect(Either.isRight(back)).toBe(true)
    if (Either.isLeft(back)) return
    expect(back.right).toEqual({
      name: 'Rent pot',
      coSigners: [
        {tag: 'cosigner#0', name: 'Jordi', accountXpubHex: XpubHex(KEY_A)},
        {tag: 'cosigner#1', name: 'Alex', accountXpubHex: XpubHex(KEY_B)},
      ],
      paymentTemplate: wallet().paymentTemplate,
      delegationTemplate: wallet().delegationTemplate,
      network: Address.Network.Mainnet,
      accountIndex: 0,
    })
  })

  it('carries no device-local state — no id, no selfGroupId, no createdAt, no registration', () => {
    const back = unpackDefinition(packDefinition(wallet()))
    if (Either.isLeft(back)) throw new Error('expected a definition')
    expect(back.right).not.toHaveProperty('id')
    expect(back.right).not.toHaveProperty('selfGroupId')
    expect(back.right).not.toHaveProperty('createdAt')
    expect(back.right).not.toHaveProperty('registration')
  })

  it('never asserts who "you" are: isSelf does not travel', () => {
    const packed = packDefinition(wallet())
    expect(packed.includes('isSelf')).toBe(false)
    const back = unpackDefinition(packed)
    if (Either.isLeft(back)) throw new Error('expected a definition')
    for (const c of back.right.coSigners) expect(c.isSelf).toBeUndefined()
  })

  it('preserves a bigint time lock exactly, past 2^53', () => {
    const slot = 9_007_199_254_740_993n
    const locked = wallet({
      paymentTemplate: {
        kind: 'all',
        scripts: [
          {kind: 'cosigner', tag: 'cosigner#0'},
          {kind: 'cosigner', tag: 'cosigner#1'},
          {kind: 'invalidHereafter', slot},
        ],
      },
    })
    const back = unpackDefinition(packDefinition(locked))
    if (Either.isLeft(back)) throw new Error('expected a definition')
    expect(back.right.paymentTemplate).toEqual(locked.paymentTemplate)
  })

  it('keeps a delegation template that differs from the payment one', () => {
    const asymmetric = wallet({
      delegationTemplate: {kind: 'any', scripts: [{kind: 'cosigner', tag: 'cosigner#0'}]},
    })
    const back = unpackDefinition(packDefinition(asymmetric))
    if (Either.isLeft(back)) throw new Error('expected a definition')
    expect(back.right.delegationTemplate).toEqual(asymmetric.delegationTemplate)
    expect(back.right.paymentTemplate).toEqual(asymmetric.paymentTemplate)
  })

  it('sends identical templates once and rebuilds both', () => {
    const packed = packDefinition(wallet())
    const wire = JSON.parse(Buffer.from(packed, 'base64url').toString('utf8'))
    expect(wire.dt).toBeUndefined()
    const back = unpackDefinition(packed)
    if (Either.isLeft(back)) throw new Error('expected a definition')
    expect(back.right.delegationTemplate).toEqual(back.right.paymentTemplate)
  })

  it('refuses a payload that is not base64, not JSON, or not an object', () => {
    for (const bad of [
      '!!!!',
      Buffer.from('not json', 'utf8').toString('base64url'),
      Buffer.from('[]', 'utf8').toString('base64url'),
    ]) {
      const back = unpackDefinition(bad)
      expect(Either.isLeft(back) && back.left.kind).toBe('unreadable')
    }
  })

  it('refuses a version it cannot read, and says which it saw', () => {
    const back = unpackDefinition(
      repack((w) => {
        w.v = 2
      }),
    )
    expect(Either.isLeft(back) && back.left).toEqual({kind: 'version', saw: 2})
  })

  it('refuses an unknown network rather than deriving addresses for one', () => {
    const back = unpackDefinition(
      repack((w) => {
        w.net = 7
      }),
    )
    expect(Either.isLeft(back) && back.left).toEqual({kind: 'invalid', field: 'network'})
  })

  it('refuses a key that is not a 64-byte xpub', () => {
    for (const key of ['ab', `${'a'.repeat(127)}z`, 'a'.repeat(126)]) {
      const back = unpackDefinition(
        repack((w) => {
          const cs = w.cs as {k: string}[]
          if (cs[0] !== undefined) cs[0].k = key
        }),
      )
      expect(Either.isLeft(back) && back.left).toEqual({kind: 'invalid', field: 'key'})
    }
  })

  it('refuses an empty roster', () => {
    const back = unpackDefinition(
      repack((w) => {
        w.cs = []
      }),
    )
    expect(Either.isLeft(back) && back.left).toEqual({kind: 'invalid', field: 'coSigners'})
  })

  it('refuses a template naming a co-signer the roster does not have', () => {
    const back = unpackDefinition(
      repack((w) => {
        w.pt = {
          kind: 'all',
          scripts: [
            {kind: 'cosigner', tag: 'cosigner#0'},
            {kind: 'cosigner', tag: 'cosigner#9'},
          ],
        }
      }),
    )
    expect(Either.isLeft(back)).toBe(true)
  })

  it('refuses two co-signers sharing one key, which would collapse the quorum', () => {
    const back = unpackDefinition(
      repack((w) => {
        const cs = w.cs as {k: string}[]
        if (cs[1] !== undefined) cs[1].k = KEY_A
      }),
    )
    expect(Either.isLeft(back) && back.left).toEqual({kind: 'invalid', field: 'duplicate-xpub'})
  })

  it('refuses an atLeast quorum larger than its branch', () => {
    const back = unpackDefinition(
      repack((w) => {
        w.pt = {kind: 'atLeast', n: 3, scripts: [{kind: 'cosigner', tag: 'cosigner#0'}]}
      }),
    )
    expect(Either.isLeft(back)).toBe(true)
  })

  it('refuses a slot that is not plain decimal digits', () => {
    for (const slot of ['0x10', ' 1 ', '', '-5']) {
      const back = unpackDefinition(
        repack((w) => {
          w.pt = {
            kind: 'all',
            scripts: [
              {kind: 'cosigner', tag: 'cosigner#0'},
              {kind: 'cosigner', tag: 'cosigner#1'},
              {kind: 'invalidBefore', slot},
            ],
          }
        }),
      )
      expect(Either.isLeft(back)).toBe(true)
    }
  })

  it('accepts a roster entry whose name the sender did not know', () => {
    const back = unpackDefinition(
      repack((w) => {
        const cs = w.cs as {n: string}[]
        if (cs[1] !== undefined) cs[1].n = ''
      }),
    )
    if (Either.isLeft(back)) throw new Error('expected a definition')
    expect(back.right.coSigners[1]?.name).toBe('')
  })

  it('refuses an unnamed wallet', () => {
    const back = unpackDefinition(
      repack((w) => {
        w.n = '   '
      }),
    )
    expect(Either.isLeft(back) && back.left).toEqual({kind: 'invalid', field: 'name'})
  })
})

describe('buildDefinitionLink', () => {
  it('round-trips through the real link parser', () => {
    const link = buildDefinitionLink(wallet())
    const action = parseBrandLink(link, 'pnyx')
    expect(action?.feature).toBe('multisig')
    expect(action?.useCase).toBe('wallet')
    if (action === null) throw new Error('expected a brand action')
    const back = definitionOfAction(action)
    expect(back !== null && Either.isRight(back)).toBe(true)
    if (back === null || Either.isLeft(back)) return
    expect(back.right.name).toBe('Rent pot')
    expect(back.right.coSigners.map((c) => c.accountXpubHex)).toEqual([KEY_A, KEY_B])
  })

  it('survives a query string: the payload is URL-safe', () => {
    const link = buildDefinitionLink(wallet())
    expect(new URL(link).searchParams.get('def')).toBe(packDefinition(wallet()))
  })

  it('fits a scannable QR for two and three co-signers, and stops claiming to past five', () => {
    const roster = (n: number) =>
      Array.from({length: n}, (_, i) => ({
        tag: `cosigner#${i}`,
        name: `Person ${i}`,
        accountXpubHex: XpubHex(String.fromCharCode(97 + i).repeat(128)),
      }))
    const nOf = (n: number) => {
      const scripts = roster(n).map((c) => ({kind: 'cosigner' as const, tag: c.tag}))
      return wallet({
        coSigners: roster(n),
        paymentTemplate: {kind: 'atLeast', n: 2, scripts},
        delegationTemplate: {kind: 'atLeast', n: 2, scripts},
      })
    }
    // Asserting the verdict, not a length: the numbers move when a field is added
    // and the question that matters is only ever "can this be scanned".
    expect(definitionFitsQr(buildDefinitionLink(nOf(2)))).toBe(true)
    expect(definitionFitsQr(buildDefinitionLink(nOf(3)))).toBe(true)
    expect(definitionFitsQr(buildDefinitionLink(nOf(5)))).toBe(false)
  })

  it('returns null for a link that is not a definition', () => {
    const action = parseBrandLink(
      `pnyx://pnyx.pxkq.uk/w1/multisig/cosigner-key?key=acct_shared_xvk1x&name=Bob&accountIndex=0`,
      'pnyx',
    )
    if (action === null) throw new Error('expected a brand action')
    expect(definitionOfAction(action)).toBeNull()
  })
})
