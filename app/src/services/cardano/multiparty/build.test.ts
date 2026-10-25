import {layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {buildMultipartyTx, type MultipartyBuildRail} from './build'
import type {ContributedUtxo, Contribution} from './compose'
import {makeValue} from './value'

// Preprod, the parameters the first co-funded transaction to reach a chain was built under.
const PARAMS = {
  minFeeA: 44n,
  minFeeB: 155_381n,
  coinsPerUtxoByte: 4310n,
  keyDeposit: 2_000_000n,
  poolDeposit: 500_000_000n,
  drepDeposit: 500_000_000n,
  maxValueSize: 5000n,
  maxTxSize: 16_384n,
}

/** Three distinct payment credentials, so a roster can tell the parties apart. */
const addressOf = (payment: string, stake = '99') => `00${payment.repeat(28)}${stake.repeat(28)}`
const ALICE = addressOf('11')
const BOB = addressOf('22')
const RECIPIENT = addressOf('33')

let rail: MultipartyBuildRail

beforeAll(() => {
  rail = {protocolParams: Effect.succeed(PARAMS)}
})

const utxo = (addressHex: string, fill: string, lovelace: bigint, assets?: ReadonlyMap<string, bigint>) =>
  ({txHash: fill.repeat(32), index: 0, addressHex, lovelace, ...(assets ? {assets} : {})}) as ContributedUtxo

const party = (
  walletId: string,
  addressHex: string,
  fill: string,
  held: bigint,
  puts: bigint,
  opts: {readonly isComposer?: boolean; readonly assets?: ReadonlyMap<string, bigint>} = {},
): Contribution => ({
  walletId,
  name: walletId,
  available: [utxo(addressHex, fill, held, opts.assets)],
  value: makeValue(puts),
  ...(opts.isComposer === true ? {isComposer: true as const} : {}),
})

const build = (contributions: readonly Contribution[], recipientLovelace: bigint) =>
  Effect.runPromise(
    Effect.either(
      buildMultipartyTx({
        rail,
        contributions,
        recipients: [{addressHex: RECIPIENT, value: makeValue(recipientLovelace)}],
        chainId: 'cardano:preprod',
        createdBy: 'alice',
        createdAt: '2026-08-10T00:00:00.000Z',
      }),
    ),
  )

const bodyOf = (bodyHex: string) =>
  Effect.runPromise(Inspect.txBody(bodyHex).pipe(Effect.provide(EvolutionDecodeLayer)))

describe('buildMultipartyTx', () => {
  it('refuses a transaction with no recipients', async () => {
    const result = await build([party('alice', ALICE, 'aa', 100_000_000n, 5_000_000n, {isComposer: true})], 0n)
    expect(result._tag).toBe('Left')
  })

  /**
   * The arithmetic the whole module exists to hold, read off the built body.
   *
   * A co-contributor's surplus must be an explicit output back to their own address. The
   * plan has exactly one change address and it belongs to the composer, so a surplus left
   * to coin selection is a surplus that lands in the composer's wallet.
   */
  it('returns a co-contributor surplus to their own address, as an explicit output', async () => {
    const result = await build(
      [
        party('alice', ALICE, 'aa', 100_000_000n, 5_000_000n, {isComposer: true}),
        party('bob', BOB, 'bb', 80_000_000n, 3_000_000n),
      ],
      8_000_000n,
    )
    if (result._tag === 'Left') throw new Error(result.left.reason)

    const {body} = await bodyOf(result.right.bodyHex)
    const toBob = (body.outputs ?? []).filter((o) => o.address.hex.toLowerCase() === BOB.toLowerCase())
    expect(toBob).toHaveLength(1)
    // Exactly what he put in, back: 80 held − 3 contributed.
    expect(toBob[0]?.value.amount).toBe(77_000_000n)
  })

  it('pays the recipient the sum of the contributions', async () => {
    const result = await build(
      [
        party('alice', ALICE, 'aa', 100_000_000n, 5_000_000n, {isComposer: true}),
        party('bob', BOB, 'bb', 80_000_000n, 3_000_000n),
      ],
      8_000_000n,
    )
    if (result._tag === 'Left') throw new Error(result.left.reason)
    const {body} = await bodyOf(result.right.bodyHex)
    const toRecipient = (body.outputs ?? []).filter((o) => o.address.hex.toLowerCase() === RECIPIENT.toLowerCase())
    expect(toRecipient).toHaveLength(1)
    expect(toRecipient[0]?.value.amount).toBe(8_000_000n)
  })

  /**
   * The composer pays the fee out of their change, and nobody else's return moves.
   *
   * Stated as a balance rather than a figure: inputs − outputs is the fee, and the fee comes
   * out of the one party who owns the change.
   */
  it('balances to the fee, which falls on the composer alone', async () => {
    const result = await build(
      [
        party('alice', ALICE, 'aa', 100_000_000n, 5_000_000n, {isComposer: true}),
        party('bob', BOB, 'bb', 80_000_000n, 3_000_000n),
      ],
      8_000_000n,
    )
    if (result._tag === 'Left') throw new Error(result.left.reason)
    const {body} = await bodyOf(result.right.bodyHex)
    const outTotal = (body.outputs ?? []).reduce((sum, o) => sum + o.value.amount, 0n)
    expect(180_000_000n - outTotal).toBe(result.right.fee)

    const toAlice = (body.outputs ?? []).filter((o) => o.address.hex.toLowerCase() === ALICE.toLowerCase())
    expect(toAlice).toHaveLength(1)
    expect(toAlice[0]?.value.amount).toBe(95_000_000n - result.right.fee)
  })

  /**
   * Every selected coin is pinned, the composer's included.
   *
   * Coin selection is free to drop an input it does not need, and dropping one drops its
   * owner from the roster — `extractRequiredSigners` reads the body. With the co-funders'
   * inputs alone covering the outputs, the composer's own coins were optimised away and the
   * wallet that built the transaction stopped being asked to sign it.
   */
  it('spends every party inputs, so the body names every party', async () => {
    const result = await build(
      [
        party('alice', ALICE, 'aa', 100_000_000n, 5_000_000n, {isComposer: true}),
        party('bob', BOB, 'bb', 80_000_000n, 3_000_000n),
      ],
      8_000_000n,
    )
    if (result._tag === 'Left') throw new Error(result.left.reason)
    const {body} = await bodyOf(result.right.bodyHex)
    expect(body.inputs).toHaveLength(2)
    expect(result.right.consumedInputs).toHaveLength(2)
  })

  it('derives a roster naming each contributing wallet, none of them signed', async () => {
    const result = await build(
      [
        party('alice', ALICE, 'aa', 100_000_000n, 5_000_000n, {isComposer: true}),
        party('bob', BOB, 'bb', 80_000_000n, 3_000_000n),
      ],
      8_000_000n,
    )
    if (result._tag === 'Left') throw new Error(result.left.reason)
    const {envelope} = result.right
    expect(envelope.kind).toBe('multiparty')
    expect(envelope.signers.map((s) => s.name).sort()).toEqual(['alice', 'bob'])
    expect(envelope.signers.every((s) => !s.signed)).toBe(true)
    // No script authorises a multiparty spend — each party's own key does.
    expect(envelope.nativeScriptHexes).toEqual([])
  })

  it('marks the composer own roster row as self, so the screen can offer their signature', async () => {
    const result = await build(
      [
        party('alice', ALICE, 'aa', 100_000_000n, 5_000_000n, {isComposer: true}),
        party('bob', BOB, 'bb', 80_000_000n, 3_000_000n),
      ],
      8_000_000n,
    )
    if (result._tag === 'Left') throw new Error(result.left.reason)
    expect(result.right.envelope.signers.find((s) => s.name === 'alice')?.isSelf).toBe(true)
  })

  /**
   * The recipients and the contributions must agree exactly.
   *
   * A shortfall cannot pay; a surplus is other people's money landing in the composer's
   * change, which is the theft case at the boundary the arithmetic does not cover.
   */
  it('refuses when the recipients ask for more than the contributions fund', async () => {
    const result = await build(
      [
        party('alice', ALICE, 'aa', 100_000_000n, 5_000_000n, {isComposer: true}),
        party('bob', BOB, 'bb', 80_000_000n, 3_000_000n),
      ],
      9_000_000n,
    )
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left.reason).toContain('recipients want')
  })

  it('refuses when the recipients ask for less, rather than paying the surplus to the composer', async () => {
    const result = await build(
      [
        party('alice', ALICE, 'aa', 100_000_000n, 5_000_000n, {isComposer: true}),
        party('bob', BOB, 'bb', 80_000_000n, 3_000_000n),
      ],
      7_000_000n,
    )
    expect(result._tag).toBe('Left')
  })

  it('surfaces a composition refusal with the party named, not a generic failure', async () => {
    const result = await build(
      [
        party('alice', ALICE, 'aa', 100_000_000n, 5_000_000n, {isComposer: true}),
        party('bob', BOB, 'bb', 2_000_000n, 3_000_000n),
      ],
      8_000_000n,
    )
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') {
      expect(result.left.compose?.kind).toBe('contribution-exceeds-inputs')
      expect(result.left.compose && 'name' in result.left.compose && result.left.compose.name).toBe('bob')
    }
  })

  /**
   * The size refusal, actually fired.
   *
   * It has a flag of its own because the remedy differs: an ordinary send answers a size
   * failure by folding its own UTxO set, which is impossible for a wallet this device only
   * watches, so the screen has to tell the user to drop a party or a recipient instead.
   * Until this test the branch had only ever been reasoned about — and a regex over an
   * error message is exactly the kind of classifier that stops matching when a dependency
   * rewords its exception, silently downgrading to the generic message.
   */
  it('names a body that exceeds the size bound as too large, not as a generic failure', async () => {
    const recipients = Array.from({length: 400}, (_, i) => ({
      addressHex: addressOf('44', (i % 200).toString(16).padStart(2, '0')),
      value: makeValue(1_000_000n),
    }))
    const result = await Effect.runPromise(
      Effect.either(
        buildMultipartyTx({
          rail,
          contributions: [
            party('alice', ALICE, 'aa', 900_000_000n, 300_000_000n, {isComposer: true}),
            party('bob', BOB, 'bb', 900_000_000n, 100_000_000n),
          ],
          recipients,
          chainId: 'cardano:preprod',
          createdBy: 'alice',
          createdAt: '2026-08-10T00:00:00.000Z',
        }),
      ),
    )
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left.tooLarge).toBe(true)
  })

  /**
   * A contribution is denominated in lovelace, so a contributor's tokens are not part of it
   * and must come back whole. Leaving them out sweeps them into the composer's change — the
   * same theft in a different denomination.
   */
  /**
   * A contributed token reaching the recipient it was contributed for.
   *
   * The case the lovelace-only recipient shape could not express, and which was refused
   * rather than built. What makes it worth a test of its own is the failure it replaces:
   * an unclaimed token does not error, it lands in the composer's change.
   */
  it('pays a contributed token through to the recipient, leaving the rest with its owner', async () => {
    const assetId = `${'cc'.repeat(28)}.4c494e4b`
    const result = await Effect.runPromise(
      Effect.either(
        buildMultipartyTx({
          rail,
          contributions: [
            party('alice', ALICE, 'aa', 100_000_000n, 5_000_000n, {isComposer: true}),
            {
              walletId: 'bob',
              name: 'bob',
              available: [utxo(BOB, 'bb', 80_000_000n, new Map([[assetId, 600_999_000n]]))],
              value: makeValue(3_000_000n, new Map([[assetId, 100n]])),
            },
          ],
          recipients: [{addressHex: RECIPIENT, value: makeValue(8_000_000n, new Map([[assetId, 100n]]))}],
          chainId: 'cardano:preprod',
          createdBy: 'alice',
          createdAt: '2026-08-10T00:00:00.000Z',
        }),
      ),
    )
    if (result._tag === 'Left') throw new Error(result.left.reason)
    const {body} = await bodyOf(result.right.bodyHex)

    const toRecipient = (body.outputs ?? []).find((o) => o.address.hex.toLowerCase() === RECIPIENT.toLowerCase())
    expect(toRecipient?.value.tokens.find((t) => t.amount === 100n)).toBeDefined()

    // And the balance of his holding comes back, not 100 short of it and not all of it.
    const toBob = (body.outputs ?? []).find((o) => o.address.hex.toLowerCase() === BOB.toLowerCase())
    expect(toBob?.value.tokens.find((t) => t.amount === 600_998_900n)).toBeDefined()
  })

  /**
   * A shared wallet's coins sit at a script address, so nothing it contributes can be
   * authorised by a payment key. Left unchecked, it drops off the roster while its money
   * stays in the body — a transaction that reads fully signed and can never be submitted.
   */
  it('refuses a contributor whose coins sit at a script address', async () => {
    const scriptAddress = `10${'55'.repeat(28)}${'99'.repeat(28)}`
    const result = await Effect.runPromise(
      Effect.either(
        buildMultipartyTx({
          rail,
          contributions: [
            party('alice', ALICE, 'aa', 100_000_000n, 5_000_000n, {isComposer: true}),
            {
              walletId: 'duo',
              name: 'Duo',
              available: [utxo(scriptAddress, 'dd', 40_000_000n)],
              value: makeValue(3_000_000n),
            },
          ],
          recipients: [{addressHex: RECIPIENT, value: makeValue(8_000_000n)}],
          chainId: 'cardano:preprod',
          createdBy: 'alice',
          createdAt: '2026-08-10T00:00:00.000Z',
        }),
      ),
    )
    expect(result._tag).toBe('Left')
    if (result._tag === 'Left') expect(result.left.scriptParty).toBe('Duo')
  })

  it('refuses a recipient asking for a token no contributor puts in', async () => {
    const assetId = `${'cc'.repeat(28)}.4c494e4b`
    const result = await Effect.runPromise(
      Effect.either(
        buildMultipartyTx({
          rail,
          contributions: [
            party('alice', ALICE, 'aa', 100_000_000n, 5_000_000n, {isComposer: true}),
            party('bob', BOB, 'bb', 80_000_000n, 3_000_000n),
          ],
          recipients: [{addressHex: RECIPIENT, value: makeValue(8_000_000n, new Map([[assetId, 1n]]))}],
          chainId: 'cardano:preprod',
          createdBy: 'alice',
          createdAt: '2026-08-10T00:00:00.000Z',
        }),
      ),
    )
    expect(result._tag).toBe('Left')
  })

  it('returns a co-contributor tokens whole alongside their lovelace surplus', async () => {
    const assetId = `${'cc'.repeat(28)}.${'4c494e4b'}`
    const result = await build(
      [
        party('alice', ALICE, 'aa', 100_000_000n, 5_000_000n, {isComposer: true}),
        party('bob', BOB, 'bb', 80_000_000n, 3_000_000n, {assets: new Map([[assetId, 600_999_000n]])}),
      ],
      8_000_000n,
    )
    if (result._tag === 'Left') throw new Error(result.left.reason)
    const {body} = await bodyOf(result.right.bodyHex)
    const toBob = (body.outputs ?? []).find((o) => o.address.hex.toLowerCase() === BOB.toLowerCase())
    expect(toBob?.value.tokens.some((a) => a.amount === 600_999_000n)).toBe(true)
  })
})
