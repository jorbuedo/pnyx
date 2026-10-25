import {isCardanoUri, parse} from '@pnyx/links'
import {Effect, Either} from 'effect'
import {describe, expect, it} from 'vitest'
import {buildFundsRequest} from './funds-request'

const ADDRESS =
  'addr_test1qr6439dwh0f5jh57y0wkzly5d8upev2z9fnppk4hk7t8smxs4ymglwdxrz6vcajhckc7j8flvsgjskaqq9zzxz2p7r0qckpvwr'

const linkOf = (lovelace = 5_000_000n): string => {
  const built = buildFundsRequest({addressBech32: ADDRESS, lovelace})
  if (!built.ok) throw new Error(`expected a link, got ${built.problem.kind}`)
  return built.link
}

/** What another wallet reads back out of it, through the CIP-13 parser. */
const parsed = (link: string) => {
  const result = Effect.runSync(Effect.either(parse(link)))
  if (Either.isLeft(result)) throw new Error(`did not parse as a Cardano URI: ${String(result.left)}`)
  if (result.right.authority !== 'pay') throw new Error(`unexpected authority ${result.right.authority}`)
  return result.right
}

describe('buildFundsRequest — choosing a standard', () => {
  it('stays on CIP-13 for an ADA-only request, which every wallet reads', () => {
    const built = buildFundsRequest({addressBech32: ADDRESS, lovelace: 1n})
    expect(built).toMatchObject({ok: true, standard: 'cip13'})
  })

  it('reaches for CIP-157 only when the request needs it', () => {
    // CIP-13 genuinely cannot carry a note, an id or an asset — Mary shipped after
    // it. Using the extension when the base standard suffices would cost
    // compatibility for nothing.
    expect(buildFundsRequest({addressBech32: ADDRESS, lovelace: 1n, note: 'lunch'})).toMatchObject({
      standard: 'cip157',
    })
    expect(buildFundsRequest({addressBech32: ADDRESS, lovelace: 1n, paymentId: 'order-1'})).toMatchObject({
      standard: 'cip157',
    })
    expect(
      buildFundsRequest({
        addressBech32: ADDRESS,
        lovelace: 0n,
        assets: [{fingerprint: 'asset12ffdj8kk2w485sr7a5ekmjjdyecz8ps2cm5zed', quantity: 3n}],
      }),
    ).toMatchObject({standard: 'cip157'})
  })

  it('round-trips a CIP-157 request through the reader', () => {
    const built = buildFundsRequest({
      addressBech32: ADDRESS,
      lovelace: 2_500_000n,
      note: 'Thanks for lunch',
      paymentId: 'order-1',
      assets: [{fingerprint: 'asset12ffdj8kk2w485sr7a5ekmjjdyecz8ps2cm5zed', quantity: 10n}],
    })
    if (!built.ok) throw new Error('expected a link')
    const result = Effect.runSync(Effect.either(parse(built.link)))
    if (Either.isLeft(result)) throw new Error('did not parse')
    expect(result.right).toEqual({
      authority: 'pay-v1',
      address: ADDRESS,
      lovelace: 2_500_000n,
      note: 'Thanks for lunch',
      paymentId: 'order-1',
      assets: [{fingerprint: 'asset12ffdj8kk2w485sr7a5ekmjjdyecz8ps2cm5zed', quantity: 10n}],
    })
  })

  it('refuses a note past the CIP-157 limit rather than emitting an unparseable link', () => {
    expect(buildFundsRequest({addressBech32: ADDRESS, lovelace: 1n, note: 'x'.repeat(65)})).toEqual({
      ok: false,
      problem: {kind: 'note-too-long'},
    })
  })

  it('writes a quantity of one bare, as the CIP prefers for a QR', () => {
    const built = buildFundsRequest({
      addressBech32: ADDRESS,
      lovelace: 0n,
      assets: [{fingerprint: 'asset12ffdj8kk2w485sr7a5ekmjjdyecz8ps2cm5zed', quantity: 1n}],
    })
    if (!built.ok) throw new Error('expected a link')
    expect(built.link).toContain('t=asset12ffdj8kk2w485sr7a5ekmjjdyecz8ps2cm5zed')
    expect(built.link).not.toContain('*1')
  })
})

describe('buildFundsRequest', () => {
  it('emits a CIP-13 pay URI, not a Pnyx-specific link', () => {
    // The whole point of the shape: every other Cardano wallet reads this. A
    // `pnyx://` request would only be payable by another copy of this app.
    expect(isCardanoUri(linkOf())).toBe(true)
    expect(linkOf().startsWith('web+cardano://pay')).toBe(true)
  })

  it('round-trips through the parser the receiving wallet uses', () => {
    expect(parsed(linkOf())).toMatchObject({authority: 'pay', address: ADDRESS, amount: 5_000_000n})
  })

  it('sends the amount in lovelace, never a decimal', () => {
    expect(parsed(linkOf(1_500_000n)).amount).toBe(1_500_000n)
  })

  it('survives an amount past 2^53', () => {
    const huge = 9_007_199_254_740_993n
    expect(parsed(linkOf(huge)).amount).toBe(huge)
  })

  it('omits the amount entirely for an open request', () => {
    // Absent means "you choose"; a literal 0 would be a request for nothing.
    const params = parsed(linkOf(0n))
    expect(params.amount).toBeUndefined()
    expect(params.address).toBe(ADDRESS)
  })

  it('refuses to build a request with no address to pay', () => {
    expect(buildFundsRequest({addressBech32: '  ', lovelace: 1n})).toEqual({
      ok: false,
      problem: {kind: 'no-address'},
    })
  })

  it('refuses a negative amount rather than emitting an unparseable URI', () => {
    expect(buildFundsRequest({addressBech32: ADDRESS, lovelace: -1n})).toEqual({
      ok: false,
      problem: {kind: 'negative-amount'},
    })
  })
})
