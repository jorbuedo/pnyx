import {Bytes, TransactionWitnessSet} from '@evolution-sdk/evolution'
import {Keys, Wallet} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {verifyWitnessCoverage} from './partial-sign.js'

const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

let witnessSetHex: string
let coveredKeyHash: string

beforeAll(async () => {
  ;({witnessSetHex, coveredKeyHash} = await Effect.runPromise(
    Effect.gen(function* () {
      const account = yield* Wallet.fromMnemonic(MNEMONIC, 0)
      const xprv = yield* account.paymentKey()
      const vkeyHex = yield* Keys.publicKey(xprv)
      const sigHex = yield* Keys.sign(xprv, 'ab'.repeat(32))
      return {
        witnessSetHex: TransactionWitnessSet.toCBORHex(
          TransactionWitnessSet.fromEncoded({
            vkeyWitnesses: [{vkey: Bytes.fromHex(vkeyHex), signature: Bytes.fromHex(sigHex)}],
          }),
        ),
        coveredKeyHash: yield* Keys.keyHash(vkeyHex),
      }
    }),
  ))
})

const run = <A, E>(eff: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(eff)

describe('verifyWitnessCoverage', () => {
  it('reports full coverage when every required hash has a witness', async () => {
    expect(await run(verifyWitnessCoverage(witnessSetHex, [coveredKeyHash]))).toEqual([])
  })

  it('is case-insensitive', async () => {
    expect(await run(verifyWitnessCoverage(witnessSetHex, [coveredKeyHash.toUpperCase()]))).toEqual([])
  })

  it('returns the missing key hashes', async () => {
    const missing = 'ff'.repeat(28)
    expect(await run(verifyWitnessCoverage(witnessSetHex, [coveredKeyHash, missing]))).toEqual([missing])
  })

  it('empty requirements are always covered (no decode)', async () => {
    expect(await run(verifyWitnessCoverage('not-even-hex', []))).toEqual([])
  })

  it('fails CborError on a malformed witness set', async () => {
    const error = await Effect.runPromise(Effect.flip(verifyWitnessCoverage('00', ['aa'.repeat(28)])))
    expect(error._tag).toBe('CborError')
  })
})
