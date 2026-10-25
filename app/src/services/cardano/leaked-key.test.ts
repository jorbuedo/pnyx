// Forges a witness that genuinely used a message-derived nonce, assembles it into
// a real signed transaction, and asserts the gate refuses it. The false-positive
// direction is covered alongside every case: this gate stands between the user and
// every broadcast, so a transaction we actually signed must always sail through.

import {
  Assets,
  Bytes,
  Address as EvAddress,
  Provider as EvolutionProvider,
  Transaction as EvolutionTransaction,
  TransactionBody,
  TransactionHash,
  TxOut,
} from '@evolution-sdk/evolution'
import {TxHashHex, XprvHex} from '@evolution-sdk/review/Brands'
import {layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import {sha512} from '@noble/hashes/sha2.js'
import {Address, Tx, Wallet} from '@pnyx/cardano-core'
import {ed25519, hex} from '@pnyx/crypto'
import {Effect, Either, Exit, Layer} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {
  broadcastFailureReason,
  guardSignedTx,
  LeakedSigningKeyError,
  scanSignedTx,
  witnessLeaksSigningKey,
} from './leaked-key'
import {chainUtxo, mockChain} from './test-provider'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const testLayer = EvolutionDecodeLayer
const run = <A>(eff: Effect.Effect<A, unknown, never>): Promise<A> => Effect.runPromise(eff as Effect.Effect<A>)
const bytes = (text: string): Uint8Array => Either.getOrThrow(hex.decode(text))

const L = ed25519.Point.Fn.ORDER
const scalarLE = (b: Uint8Array): bigint => {
  let x = 0n
  for (let i = b.length - 1; i >= 0; i--) x = (x << 8n) | BigInt(b[i] as number)
  return x % L
}
const bytesLE = (x: bigint): Uint8Array => {
  const out = new Uint8Array(32)
  let v = x
  for (let i = 0; i < 32; i++) {
    out[i] = Number(v & 0xffn)
    v >>= 8n
  }
  return out
}
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
const basepointMul = (r: bigint): Uint8Array => ed25519.Point.BASE.multiply(r === 0n ? L : r).toBytes()

/** A key that signs with `r = H(M)` — the plainest of the catalogued derivations. */
const weakSecret = scalarLE(sha512(new TextEncoder().encode('leaked-key-test')))
const weakPublicHex = hex.encode(basepointMul(weakSecret))
const forgeWeak = (message: Uint8Array): Uint8Array => {
  const r = scalarLE(sha512(message))
  const R = basepointMul(r)
  const h = scalarLE(sha512(cat(R, bytes(weakPublicHex), message)))
  return cat(R, bytesLE((((r + h * weakSecret) % L) + L) % L))
}

type Fixture = {
  readonly bodyHex: string
  readonly paymentXprv: string
  readonly addressBech32: string
}
let fx: Fixture

beforeAll(async () => {
  fx = await run(
    Effect.gen(function* () {
      const own = yield* Wallet.fromMnemonic(MNEMONIC, 0)
      const addressBech32 = yield* own.baseAddress(Address.Network.Testnet)
      const addressHex = Address.fromBech32Sync(addressBech32)
      const bodyHex = TransactionBody.toCBORHex(
        TransactionBody.fromEncoded({
          inputs: [Bytes.fromHex(Tx.inputHex(TxHashHex('11'.repeat(32)), 0n))],
          outputs: [
            TxOut.toCBORBytes(
              new TxOut.TransactionOutput({
                address: EvAddress.fromHex(addressHex),
                assets: Assets.fromLovelace(800_000n),
                encodingFormat: 'babbage',
              }),
            ),
          ],
          fee: 200_000n,
          ttl: 99_000_000n,
        }),
      )
      return {bodyHex, addressBech32, paymentXprv: yield* own.paymentKey()}
    }).pipe(Effect.provide(testLayer)),
  )
})

const bodyHash = (): string => Tx.bodyHash(fx.bodyHex)
const weakWitness = () => ({vkeyHex: weakPublicHex, sigHex: hex.encode(forgeWeak(bytes(bodyHash())))})
const honestWitness = () => run(Tx.partialSign(fx.bodyHex, XprvHex(fx.paymentXprv)).pipe(Effect.provide(testLayer)))
const signedTxWith = (witnesses: readonly {vkeyHex: string; sigHex: string}[]): Promise<string> =>
  run(Tx.assemble(fx.bodyHex, witnesses).pipe(Effect.provide(testLayer)))

const failureOf = <E>(exit: Exit.Exit<unknown, E>): E | null => {
  if (!Exit.isFailure(exit)) return null
  return exit.cause._tag === 'Fail' ? exit.cause.error : null
}

describe('witnessLeaksSigningKey', () => {
  it('flags a witness whose nonce came from the body hash', () => {
    const w = weakWitness()
    expect(witnessLeaksSigningKey(bodyHash())(w.vkeyHex, w.sigHex)).toBe(true)
  })

  it('clears a witness this wallet actually signed', async () => {
    const w = await honestWitness()
    expect(witnessLeaksSigningKey(bodyHash())(w.vkeyHex, w.sigHex)).toBe(false)
  })

  it('is bound to one message: the same weak witness is clean against another body', () => {
    const otherHash = Tx.bodyHash(
      TransactionBody.toCBORHex(
        TransactionBody.fromEncoded({
          inputs: [Bytes.fromHex(Tx.inputHex(TxHashHex('22'.repeat(32)), 0n))],
          outputs: [],
          fee: 300_000n,
        }),
      ),
    )
    const w = weakWitness()
    expect(witnessLeaksSigningKey(otherHash)(w.vkeyHex, w.sigHex)).toBe(false)
  })

  it('treats non-hex as unanswerable rather than throwing', () => {
    const w = weakWitness()
    expect(witnessLeaksSigningKey('zz')(w.vkeyHex, w.sigHex)).toBe(false)
    expect(witnessLeaksSigningKey(bodyHash())('nothex', 'alsonothex')).toBe(false)
  })
})

describe('scanSignedTx', () => {
  it('names the leaking witness and the derivation that proves it', async () => {
    const scan = await run(scanSignedTx(await signedTxWith([weakWitness()])))
    expect(scan).toEqual({checked: true, leak: {vkeyHex: weakPublicHex, derivation: 'H(M)'}})
  })

  it('finds the weak witness even when an honest one signs alongside it', async () => {
    const scan = await run(scanSignedTx(await signedTxWith([await honestWitness(), weakWitness()])))
    expect(scan.checked && scan.leak?.vkeyHex).toBe(weakPublicHex)
  })

  it('reports a genuinely signed transaction as checked and clean', async () => {
    expect(await run(scanSignedTx(await signedTxWith([await honestWitness()])))).toEqual({
      checked: true,
      leak: null,
    })
  })

  it('reports a transaction with no vkey witnesses as checked and clean', async () => {
    expect(await run(scanSignedTx(await signedTxWith([])))).toEqual({checked: true, leak: null})
  })

  it('separates "could not read it" from "nothing found"', async () => {
    expect(await run(scanSignedTx('not-a-transaction'))).toMatchObject({checked: false})
  })
})

describe('guardSignedTx', () => {
  it('refuses a transaction whose witness leaks its key, naming the witness', async () => {
    const exit = await Effect.runPromiseExit(guardSignedTx(await signedTxWith([weakWitness()])))
    const error = failureOf(exit)
    expect(error).toBeInstanceOf(LeakedSigningKeyError)
    expect(error?.vkeyHex).toBe(weakPublicHex)
    expect(error?.derivation).toBe('H(M)')
    expect(error?.message).toContain('leaks its signing key')
  })

  it('lets an honestly signed transaction through', async () => {
    await expect(run(guardSignedTx(await signedTxWith([await honestWitness()])))).resolves.toBeUndefined()
  })

  it('lets an unparseable transaction through — the node rejects it, not us', async () => {
    await expect(run(guardSignedTx('not-a-transaction'))).resolves.toBeUndefined()
  })
})

describe('the rail applies the gate to every broadcast', () => {
  /**
   * A rail whose chain client records what reached the network.
   *
   * ⚠️ The spy is on `submitTx` of the TYPED client, because that is the only route out now:
   * `rail.chain` has `submitTx` omitted, so `rail.submit` is the one caller of it and the guard
   * is unconditionally in front. A spy on the wallet-shaped port would watch a path the rail no
   * longer takes, and every assertion below would pass over a broadcast nothing checked.
   */
  const railWithSpy = (submitted: string[]) =>
    run(
      Effect.gen(function* () {
        const base = yield* EvolutionProvider.ProviderEffect
        const {makeCardanoRail} = yield* Effect.promise(() => import('./rail'))
        return yield* makeCardanoRail({
          config: {network: 'preprod', koiosUrl: 'https://koios.internal/api/v1', networkId: 0, protocolMagic: 1},
          addressBech32: fx.addressBech32,
          accountIndex: 0,
        }).pipe(
          Effect.provideService(EvolutionProvider.ProviderEffect, {
            ...base,
            submitTx: (tx) => {
              submitted.push(EvolutionTransaction.toCBORHex(tx))
              return base.submitTx(tx)
            },
          }),
        )
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            EvolutionDecodeLayer,
            // ⚠️ The input this test's body spends has to be IN the ledger: the mock rejects an
            // input it does not hold, the way a node does. The mock this replaced accepted any
            // bytes, so "passes an honestly signed transaction through" was asserted over a
            // transaction no chain would have taken.
            mockChain({utxos: [chainUtxo({address: fx.addressBech32, txHash: '11', lovelace: 100_000_000n})]}),
          ),
        ),
      ),
    )

  it('refuses a leaking transaction without ever reaching the provider', async () => {
    const submitted: string[] = []
    const rail = await railWithSpy(submitted)
    const signedTxHex = await signedTxWith([weakWitness()])
    const error = failureOf(await Effect.runPromiseExit(rail.submit(signedTxHex)))
    expect(error).toBeInstanceOf(LeakedSigningKeyError)
    expect(submitted).toEqual([])
  })

  it('passes an honestly signed transaction to the provider unchanged', async () => {
    const submitted: string[] = []
    const rail = await railWithSpy(submitted)
    const signedTxHex = await signedTxWith([await honestWitness()])

    const txHash = await run(rail.submit(signedTxHex))

    // ⚠️ The REAL id of these bytes, not a fixed `00…00` the old mock answered with. Asserting
    // the bytes reached the provider is the point of the spy; asserting the id is what proves
    // the hash the wallet records is the one the chain computed from them.
    expect(submitted).toEqual([signedTxHex])
    expect(txHash).toBe(
      TransactionHash.toHex(TransactionBody.toHash(EvolutionTransaction.fromCBORHex(signedTxHex).body)),
    )
  })

  it('gates submitAndTrack too, so the pending overlay never records a refused tx', async () => {
    const submitted: string[] = []
    const rail = await railWithSpy(submitted)
    const signedTxHex = await signedTxWith([weakWitness()])
    const exit = await Effect.runPromiseExit(rail.submitAndTrack(signedTxHex, {consumedUtxoIds: [], change: []}))
    expect(failureOf(exit)).toBeInstanceOf(LeakedSigningKeyError)
    expect(submitted).toEqual([])
    expect(await run(rail.pendingTracker.pending)).toEqual([])
  })
})

describe('broadcastFailureReason', () => {
  // ⚠️ The ProviderError's own message names the OPERATION; the node's refusal is in the cause
  // underneath it. A preprod submit on 2026-10-21 returned HTTP 400 and the trail read only
  // `Koios submitTx failed`, which cannot be told apart from any other submit failure.
  it('carries the node\'s words up from the cause', () => {
    const error = new EvolutionProvider.ProviderError({
      message: 'Koios submitTx failed',
      cause: {message: 'non 2xx status code : {"error":"ValueNotConservedUTxO"}'},
    })
    expect(broadcastFailureReason(error)).toBe(
      'Koios submitTx failed: non 2xx status code : {"error":"ValueNotConservedUTxO"}',
    )
  })

  it('walks a nested chain, outermost first', () => {
    const error = new EvolutionProvider.ProviderError({
      message: 'Koios submitTx failed',
      cause: {message: 'request failed', cause: {message: 'fetch: network down'}},
    })
    expect(broadcastFailureReason(error)).toBe('Koios submitTx failed: request failed: fetch: network down')
  })

  it('is the message alone when there is no cause, rather than a trailing separator', () => {
    const error = new EvolutionProvider.ProviderError({message: 'Koios submitTx failed'})
    expect(broadcastFailureReason(error)).toBe('Koios submitTx failed')
  })

  it('does not repeat a message the chain carries twice', () => {
    const error = new EvolutionProvider.ProviderError({
      message: 'Koios submitTx failed',
      cause: {message: 'boom', cause: {message: 'boom'}},
    })
    expect(broadcastFailureReason(error)).toBe('Koios submitTx failed: boom')
  })

  it('terminates on a cyclic cause chain', () => {
    const cycle: {message: string; cause?: unknown} = {message: 'round'}
    cycle.cause = cycle
    const error = new EvolutionProvider.ProviderError({message: 'Koios submitTx failed', cause: cycle})
    expect(broadcastFailureReason(error)).toBe('Koios submitTx failed: round')
  })

  it('keeps a LeakedSigningKeyError reading as its own refusal', () => {
    const error = new LeakedSigningKeyError({vkeyHex: 'aa'.repeat(32), derivation: 'H(M)'})
    expect(broadcastFailureReason(error)).toContain('leaks its signing key')
  })
})
