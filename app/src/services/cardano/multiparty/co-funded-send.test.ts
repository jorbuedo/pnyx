import {
  Address as EvolutionAddress,
  Assets as EvolutionAssets,
  UTxO as EvolutionUTxO,
  TransactionHash,
} from '@evolution-sdk/evolution'
import {Bech32} from '@evolution-sdk/review/Brands'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {buildCoFundedSend, type CoFundInput, type CoFundResult, coFundMessage} from './co-funded-send'

const ALICE = Bech32(
  'addr_test1qq8ac7qqy0vtulyl7wntmsxc6wex80gvcyjy33qffrhm7sh927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqkt5dmn',
)
const BOB = Bech32(
  'addr_test1qqz85693g4fr8c55mfyxhae8j2u04pydxrgqr73vmwpx3a8927ysx5sftuw0dlft05dz3c7revpf7jx0xnlcjz3g69mqlu9096',
)

const ADA_ID = ''
const TOKEN_ID = `${'cc'.repeat(28)}.4c494e4b`

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

/** A chain row as the typed client answers it. */
const utxo = (address: Bech32, txHash: string, coin: bigint, asset?: readonly [string, string, bigint]) =>
  new EvolutionUTxO.UTxO({
    transactionId: TransactionHash.fromHex(txHash),
    index: 0n,
    address: EvolutionAddress.fromBech32(address),
    assets:
      asset === undefined
        ? EvolutionAssets.fromLovelace(coin)
        : EvolutionAssets.addByHex(EvolutionAssets.fromLovelace(coin), asset[0], asset[1], asset[2]),
  })

let rail: CoFundInput['rail']

beforeAll(() => {
  rail = {
    config: {network: 'preprod'} as CoFundInput['rail']['config'],
    protocolParams: Effect.succeed(PARAMS),
    chain: {
      getAccountUtxos: () =>
        Effect.succeed([
          utxo(ALICE, 'aa'.repeat(32), 100_000_000n),
          // Bob holds the token, so "can he contribute one" is a real question here rather
          // than one the fixture answers no to for him.
          utxo(BOB, 'bb'.repeat(32), 80_000_000n, ['cc'.repeat(28), '4c494e4b', 600_999_000n]),
        ]),
      getUtxos: () => Effect.succeed([]),
    },
  } as CoFundInput['rail']
})

const source = (groupId: string, lovelace: bigint, isComposer: boolean, assets = new Map<string, bigint>()) => ({
  groupId,
  name: groupId,
  isComposer,
  lovelace,
  assets,
})

const target = (amounts: ReadonlyMap<string, bigint>) => ({addressHex: `00${'33'.repeat(56)}`, amounts})

const input = (over: Partial<CoFundInput>): CoFundInput => ({
  rail,
  groupId: 'alice',
  name: 'Alice',
  sources: [source('alice', 5_000_000n, true), source('bob', 3_000_000n, false)],
  targets: [target(new Map([[ADA_ID, 8_000_000n]]))],
  addressesOf: async (id) => (id === 'alice' ? [ALICE] : [BOB]),
  now: '2026-08-10T00:00:00.000Z',
  ...over,
})

const say = ((key: string, vars?: Record<string, unknown>) =>
  vars === undefined ? key : `${key}:${JSON.stringify(vars)}`) as never

const format = (value: bigint) => `${value}`

describe('buildCoFundedSend', () => {
  /**
   * The wallets decide the total, and a disagreement is not something to absorb: too little
   * cannot pay, and too much lands in the composer's change — other people's money moving
   * somewhere nobody chose.
   */
  it('refuses when the contributions and the recipients disagree, naming both figures', async () => {
    const result = await buildCoFundedSend(input({targets: [target(new Map([[ADA_ID, 9_000_000n]]))]}))
    expect(result.ok).toBe(false)
    if (!result.ok && 'reason' in result && result.reason === 'unbalanced') {
      expect(result.contributed).toBe(8_000_000n)
      expect(result.requested).toBe(9_000_000n)
    } else {
      throw new Error('expected an unbalanced refusal')
    }
  })

  /**
   * A contributed token that reaches no recipient is not a token problem, it is an
   * unbalanced send — and the distinction matters because the *outcome* of letting it
   * through is the token landing in the composer's change. Balancing per asset is what
   * makes this one rule rather than a special case beside it.
   */
  it('refuses a contributed token that no recipient claims', async () => {
    const result = await buildCoFundedSend(
      input({
        sources: [source('alice', 5_000_000n, true), source('bob', 3_000_000n, false, new Map([[TOKEN_ID, 5n]]))],
      }),
    )
    expect(result.ok).toBe(false)
    // Not `unbalanced`: the ADA agrees, and that message states two equal figures.
    if (!result.ok && 'reason' in result) expect(result.reason).toBe('unbalanced-tokens')
  })

  it('refuses a recipient asking for a token no wallet puts in', async () => {
    const result = await buildCoFundedSend(
      input({
        targets: [
          target(
            new Map([
              [ADA_ID, 8_000_000n],
              [TOKEN_ID, 1n],
            ]),
          ),
        ],
      }),
    )
    expect(result.ok).toBe(false)
    if (!result.ok && 'reason' in result) expect(result.reason).toBe('unbalanced-tokens')
  })

  /** Contributed and claimed: the send the two refusals above used to stand in for. */
  it('accepts a token contributed by one wallet and sent to a recipient', async () => {
    const result = await buildCoFundedSend(
      input({
        sources: [source('alice', 5_000_000n, true), source('bob', 3_000_000n, false, new Map([[TOKEN_ID, 5n]]))],
        targets: [
          target(
            new Map([
              [ADA_ID, 8_000_000n],
              [TOKEN_ID, 5n],
            ]),
          ),
        ],
      }),
    )
    expect(result.ok).toBe(true)
  })

  /** The composer owns the change and therefore pays the fee; with no coins there is none. */
  it('refuses when the composer has no readable utxos', async () => {
    const result = await buildCoFundedSend(input({addressesOf: async (id) => (id === 'alice' ? [] : [BOB])}))
    expect(result.ok).toBe(false)
    if (!result.ok && 'reason' in result) expect(result.reason).toBe('unreadable-wallet')
  })
})

/**
 * Every refusal shape reaches a sentence of its own.
 *
 * This function existed for a session with **no callers**: the send flow routed only the
 * compose branch and printed one flat "could not build" for everything else. So the case
 * these assertions really cover is a new refusal being added and quietly falling through.
 */
describe('coFundMessage', () => {
  const message = (result: Extract<CoFundResult, {ok: false}>) => coFundMessage(result, say, format as never, 'tADA')

  it('names the party a composition refusal is about', () => {
    expect(
      message({
        ok: false,
        compose: {kind: 'return-below-min-ada', walletId: 'b', name: 'Bob', returned: 1n, minimum: 2n},
      }),
    ).toContain('coFund.errorReturnTooSmall')
    expect(
      message({
        ok: false,
        compose: {
          kind: 'contribution-exceeds-inputs',
          walletId: 'b',
          name: 'Bob',
          available: {lovelace: 0n, assets: new Map()},
          requested: {lovelace: 1n, assets: new Map()},
        },
      }),
    ).toContain('Bob')
  })

  it('states both figures for an unbalanced send', () => {
    const text = message({ok: false, reason: 'unbalanced', contributed: 8_000_000n, requested: 9_000_000n})
    expect(text).toContain('8000000')
    expect(text).toContain('9000000')
  })

  /** The branch that printed a literal `{reason}` because nobody passed the variable. */
  it('carries the builder own sentence for a named build failure', () => {
    const text = message({ok: false, reason: 'failed', detail: 'value too large'})
    expect(text).toContain('value too large')
    expect(text).not.toContain('{reason}')
  })

  it('falls back to the generic message only when there is no detail to give', () => {
    expect(message({ok: false, reason: 'failed'})).toBe('coFund.errorGeneric')
  })

  it('names a token mismatch rather than restating two equal ADA figures', () => {
    const text = message({ok: false, reason: 'unbalanced-tokens', assetIds: ['a', 'b']})
    expect(text).toContain('coFund.tokenMismatch')
    expect(text).toContain('2')
  })

  it.each([
    'too-large',
    'composer-empty',
    'unreadable-wallet',
  ] as const)('gives %s its own sentence rather than the generic one', (reason) => {
    expect(message({ok: false, reason})).not.toBe('coFund.errorGeneric')
  })
})
