import {KeyHashHex} from '@evolution-sdk/review/Brands'
import {Scripts} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {envelopeRequiredSignatures, requiredSignaturesOf} from './native-script'

const run = <A>(effect: Effect.Effect<A, unknown>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A>)

const key = (n: number) => run(Scripts.pubkey(KeyHashHex(`${n}${n}`.repeat(28).slice(0, 56))))

describe('requiredSignaturesOf', () => {
  it('is one for a single key', async () => {
    expect(requiredSignaturesOf(await key(1))).toBe(1)
  })

  it('is every key under an `all`', async () => {
    const script = await run(Scripts.all(await Promise.all([key(1), key(2), key(3)])))
    expect(requiredSignaturesOf(script)).toBe(3)
  })

  it('is one under an `any`, however many branches there are', async () => {
    const script = await run(Scripts.any(await Promise.all([key(1), key(2), key(3)])))
    expect(requiredSignaturesOf(script)).toBe(1)
  })

  it('is n — not k — for at_least, which is the whole point', async () => {
    // Counting the roster gives 3 here, so a 2-of-3 wallet would wait forever
    // for a third signature and never submit a transaction already valid.
    const script = await run(Scripts.nOfK(2n, await Promise.all([key(1), key(2), key(3)])))
    expect(requiredSignaturesOf(script)).toBe(2)
  })

  it('ignores time locks, which constrain when rather than who', async () => {
    const script = await run(
      Scripts.all([
        await run(Scripts.invalidBefore(100n)),
        await run(Scripts.nOfK(2n, await Promise.all([key(1), key(2), key(3)]))),
        await run(Scripts.invalidHereafter(900n)),
      ]),
    )
    expect(requiredSignaturesOf(script)).toBe(2)
  })

  it('takes the cheapest branch of an `any`, not the first', async () => {
    const script = await run(
      Scripts.any([await run(Scripts.nOfK(2n, await Promise.all([key(1), key(2)]))), await key(3)]),
    )
    expect(requiredSignaturesOf(script)).toBe(1)
  })

  it('takes the n cheapest branches of an at_least, whatever their order', async () => {
    const expensive = await run(Scripts.all(await Promise.all([key(1), key(2), key(3)])))
    const script = await run(Scripts.nOfK(2n, [expensive, await key(4), await key(5)]))
    expect(requiredSignaturesOf(script)).toBe(2)
  })

  it('sums nested branches an `all` requires', async () => {
    const branch = await run(Scripts.nOfK(2n, await Promise.all([key(1), key(2), key(3)])))
    expect(requiredSignaturesOf(await run(Scripts.all([branch, branch])))).toBe(4)
  })
})

describe('envelopeRequiredSignatures', () => {
  it('reads the payment script an envelope carries', async () => {
    const script = await run(Scripts.nOfK(2n, await Promise.all([key(1), key(2), key(3)])))
    expect(envelopeRequiredSignatures([script])).toBe(2)
  })

  it('is null for an envelope with no scripts, so the caller falls back knowingly', () => {
    expect(envelopeRequiredSignatures([])).toBeNull()
  })

  it('is null for bytes that are not a native script, rather than a guess', () => {
    // A wrong number here either blocks a submittable transaction or releases an
    // unsubmittable one; both are worse than saying so.
    expect(envelopeRequiredSignatures(['deadbeef'])).toBeNull()
    expect(envelopeRequiredSignatures(['zz'])).toBeNull()
  })
})
