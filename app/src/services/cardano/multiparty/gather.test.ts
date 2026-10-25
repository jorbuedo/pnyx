import {
  Address as EvolutionAddress,
  Assets as EvolutionAssets,
  UTxO as EvolutionUTxO,
  TransactionHash,
} from '@evolution-sdk/evolution'
import {Bech32, TxHashHex} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {describe, expect, it} from 'vitest'
import {contributableTotal, type GatherRail, gatherContributableUtxos} from './gather'

/** Two addresses of one wallet: same stake credential, different payment keys. */
const OWNED_A = Bech32(
  'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn',
)
const OWNED_B = Bech32(
  'addr_test1qqz85693g4fr8c55mfyxhae8j2u04pydxrgqr73vmwpx3a8927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqlu9096',
)
/**
 * A different wallet delegating to the *same* stake account.
 *
 * The case that makes `owned` load-bearing: a stake credential is public, so anyone may
 * delegate to it and their UTxOs come back from `/account_utxos` looking like ours.
 */
const FOREIGN_SAME_STAKE = Bech32(
  'addr_test1qzfysvkldcs0u35d8esynksfqapfdahfknur6dzx7sgqsvh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mq5d2gfl',
)

/** A chain row as the typed client answers it. The address is REQUIRED there. */
const providerUtxo = (address: Bech32, txHash: TxHashHex, coin: bigint) =>
  new EvolutionUTxO.UTxO({
    transactionId: TransactionHash.fromHex(txHash),
    index: 0n,
    address: EvolutionAddress.fromBech32(address),
    assets: EvolutionAssets.fromLovelace(coin),
  })

const railWith = (opts: {
  readonly account?: readonly ReturnType<typeof providerUtxo>[]
  readonly perAddress?: ReadonlyMap<string, readonly ReturnType<typeof providerUtxo>[]>
  readonly calls?: string[]
}): GatherRail =>
  ({
    chain: {
      ...(opts.account === undefined
        ? {}
        : {
            getAccountUtxos: (stake: string) => {
              opts.calls?.push(`account:${stake}`)
              return Effect.succeed([...(opts.account ?? [])])
            },
          }),
      getUtxos: (address: EvolutionAddress.Address) => {
        const bech32 = EvolutionAddress.toBech32(address)
        opts.calls?.push(`address:${bech32}`)
        return Effect.succeed([...(opts.perAddress?.get(bech32) ?? [])])
      },
    },
  }) as GatherRail

/** ⚠️ No layer. `gatherContributableUtxos` needed a `Codec` from the context; it does not now. */
const attempt = <A, E>(eff: Effect.Effect<A, E>) => Effect.runPromise(Effect.either(eff))

describe('gatherContributableUtxos', () => {
  it('refuses a wallet whose addresses cannot be read at all', async () => {
    const result = await attempt(
      gatherContributableUtxos({rail: railWith({account: []}), addresses: ['not-an-address']}),
    )
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left.reason).toBe('no readable addresses')
  })

  it('reads the whole account in one call rather than one per address', async () => {
    const calls: string[] = []
    const result = await attempt(
      gatherContributableUtxos({
        rail: railWith({account: [providerUtxo(OWNED_A, TxHashHex('aa'.repeat(32)), 5_000_000n)], calls}),
        addresses: [OWNED_A, OWNED_B],
      }),
    )
    if (result._tag === 'Left') throw new Error(String(result.left))
    expect(result.right).toHaveLength(1)
    // Two addresses, one call. The per-address fanout is what timed out every wallet.
    expect(calls.filter((c) => c.startsWith('account:'))).toHaveLength(1)
    expect(calls.filter((c) => c.startsWith('address:'))).toHaveLength(0)
  })

  /**
   * The security property of `owned`, not a tidiness one.
   *
   * Contributing a foreign UTxO builds a body naming an input the contributing party cannot
   * witness, so the transaction can never be completed — and the composer would not find out
   * until a co-signer failed to produce a signature for a coin that was never theirs.
   */
  it('drops an account UTxO sitting at an address this wallet does not own', async () => {
    const result = await attempt(
      gatherContributableUtxos({
        rail: railWith({
          account: [
            providerUtxo(OWNED_A, TxHashHex('aa'.repeat(32)), 5_000_000n),
            providerUtxo(FOREIGN_SAME_STAKE, TxHashHex('bb'.repeat(32)), 999_000_000n),
          ],
        }),
        addresses: [OWNED_A, OWNED_B],
      }),
    )
    if (result._tag === 'Left') throw new Error(String(result.left))
    expect(result.right).toHaveLength(1)
    expect(result.right[0]?.lovelace).toBe(5_000_000n)
  })

  it('carries each utxo own address, which is where its return will go', async () => {
    const result = await attempt(
      gatherContributableUtxos({
        rail: railWith({account: [providerUtxo(OWNED_B, TxHashHex('cc'.repeat(32)), 7_000_000n)]}),
        addresses: [OWNED_A, OWNED_B],
      }),
    )
    if (result._tag === 'Left') throw new Error(String(result.left))
    expect(result.right[0]?.addressHex).toBe(Address.fromBech32Sync(Bech32(OWNED_B)))
  })

  it('falls back to a per-address fanout when the provider has no account query', async () => {
    const calls: string[] = []
    const result = await attempt(
      gatherContributableUtxos({
        rail: railWith({
          perAddress: new Map([[OWNED_A, [providerUtxo(OWNED_A, TxHashHex('dd'.repeat(32)), 2_000_000n)]]]),
          calls,
        }),
        addresses: [OWNED_A, OWNED_B],
      }),
    )
    if (result._tag === 'Left') throw new Error(String(result.left))
    expect(result.right).toHaveLength(1)
    expect(calls).toEqual([`address:${OWNED_A}`, `address:${OWNED_B}`])
  })
})

describe('contributableTotal', () => {
  it('sums lovelace across the gathered set', () => {
    expect(
      contributableTotal([
        {txHash: TxHashHex('aa'.repeat(32)), index: 0, addressHex: '00', lovelace: 3n},
        {txHash: TxHashHex('bb'.repeat(32)), index: 1, addressHex: '00', lovelace: 4n},
      ]),
    ).toBe(7n)
  })

  it('is zero for a wallet with nothing to give', () => {
    expect(contributableTotal([])).toBe(0n)
  })
})
