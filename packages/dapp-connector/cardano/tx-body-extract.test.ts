import {Assets as EvAssets} from '@evolution-sdk/evolution'
import {Plan} from '@evolution-sdk/plan'
import {TxHashHex} from '@evolution-sdk/review/Brands'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Address, Tx, Wallet} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'

// Guards the dApp signTx bridge: CIP-30 hands over a full tx, but the review +
// signing rails work on the body. Inspect.txBodyFromTx must yield a body whose
// hash equals the full-tx hash, or witness coverage / assembly would mismatch.
const MNEMONIC = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'

describe('Inspect.txBodyFromTx', () => {
  it('slices a body byte-identical to the plan body, matching the full-tx hash', async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const account = yield* Wallet.fromMnemonic(MNEMONIC, 0)
        const xprv = yield* account.paymentKey()
        const addrHex = yield* Address.fromBech32(yield* account.baseAddress(1))
        const built = Plan.build({
          inputs: [{txHash: TxHashHex('11'.repeat(32)), index: 0, assets: EvAssets.fromLovelace(5_000_000n)}],
          outputs: [{addressHex: addrHex, assets: EvAssets.fromLovelace(1_000_000n)}],
          changeAddressHex: addrHex,
          params: {
            minFeeA: 44n,
            minFeeB: 155_381n,
            coinsPerUtxoByte: 4_310n,
            keyDeposit: 2_000_000n,
            poolDeposit: 500_000_000n,
            drepDeposit: 500_000_000n,
          },
          signers: [xprv],
        })
        const body = yield* Inspect.txBodyFromTx(built.signedTxHex)
        return {
          bodyMatches: body === built.bodyHex,
          hashMatches: Tx.bodyHash(body) === Tx.bodyHashOfSigned(built.signedTxHex),
        }
      }),
    )
    expect(result.bodyMatches).toBe(true)
    expect(result.hashMatches).toBe(true)
  })

  it('fails CborError on malformed input', async () => {
    const error = await Effect.runPromise(Effect.flip(Inspect.txBodyFromTx('00zz')))
    expect(error._tag).toBe('CborError')
  })
})
