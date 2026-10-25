// The tools the app answers itself. Two things are worth pinning: the capability gate is at the *door*
// (a client may call any tool by name without listing first), and a store that could not be read never
// reaches an agent as an empty history.
import type {TxListItem} from '@pnyx/store/tx-table'
import {describe, expect, it} from 'vitest'
import {type AgentCapabilities, DEFAULT_AGENT_CAPABILITIES} from './agent-capabilities'
import {
  createLocalToolRunner,
  describeBalance,
  describeShieldedFreshness,
  describeUtxos,
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  readBoundedInteger,
  readListHistoryArgs,
  readReadUtxosArgs,
  UTXO_DEFAULT_LIMIT,
  UTXO_MAX_LIMIT,
} from './local-tools'
import {forgetOutcomes, recordOutcome} from './outcomes'

const caps = (over: Partial<AgentCapabilities> = {}): AgentCapabilities => ({
  ...DEFAULT_AGENT_CAPABILITIES,
  scopes: [{groupId: 'g1', accountIndex: 0}],
  ...over,
})

const row = (hash: string): TxListItem =>
  ({groupId: 'g1', chainId: 'cardano:mainnet', accountIndex: 0, hash}) as TxListItem

const deps = (
  over: Partial<Parameters<typeof createLocalToolRunner>[1]> = {},
): Parameters<typeof createLocalToolRunner>[1] => ({
  listHistory: async () => [],
  txStatus: async () => 'unknown' as const,
  midnightSyncAgeMs: () => null,
  shieldedFreshness: async () => null,
  syncShielded: async () => null,
  readBalance: async () => ({lovelace: 0n, assets: []}),
  readTransaction: async () => null,
  readAddresses: async () => ({receive: 'addr_test1x', all: [], reward: null}),
  readUtxos: async () => ({total: 0, utxos: []}),
  buildTransfer: async () => ({ok: true as const, value: {submitted: false}}),
  buildProgrammableTransfer: async () => ({ok: true as const, value: {submitted: false}}),
  buildMint: async () => ({ok: true as const, value: {submitted: false}}),
  buildDelegation: async () => ({ok: true as const, value: {submitted: false}}),
  buildConsolidation: async () => ({ok: true as const, value: {submitted: false}}),
  buildDeploy: async () => ({ok: true as const, value: {submitted: false}}),
  buildCoFunded: async () => ({ok: true as const, value: {pendingId: 'p'}}),
  signCoFunded: async () => ({ok: true as const, value: {submitted: false}}),
  readMidnightTransaction: async () => ({ok: true as const, value: {understood: true}}),
  buildMidnightCoFunded: async () => ({ok: true as const, value: {submitted: false}}),
  ...over,
})

const runnerOver = (
  listHistory: (q: {limit: number; offset: number}) => Promise<readonly TxListItem[]>,
  capabilities = caps(),
) => createLocalToolRunner(capabilities, deps({listHistory}))

describe('readBoundedInteger', () => {
  it('falls back when the argument is absent', () => {
    expect(readBoundedInteger({}, 'limit', {min: 1, max: 200, fallback: 50})).toEqual({ok: true, value: 50})
  })

  // ⚠️ Refused, not clamped: silently returning 200 rows for a request for 1,000 reads as "that is all
  // there is", and the agent stops paging.
  it('refuses a value outside the declared range instead of clamping it', () => {
    const out = readBoundedInteger({limit: 1000}, 'limit', {min: 1, max: 200, fallback: 50})
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.message).toContain('between 1 and 200')
    expect(out.ok === false && out.message).toContain('1000')
  })

  it('refuses a fraction, a negative and a non-number alike', () => {
    for (const bad of [1.5, -1, '10', Number.NaN]) {
      expect(readBoundedInteger({limit: bad}, 'limit', {min: 1, max: 200, fallback: 50}).ok).toBe(false)
    }
  })
})

describe('readListHistoryArgs', () => {
  it('defaults a page nobody sized', () => {
    expect(readListHistoryArgs({})).toEqual({ok: true, value: {limit: HISTORY_DEFAULT_LIMIT, offset: 0}})
  })

  it('takes a page the caller sized', () => {
    expect(readListHistoryArgs({limit: HISTORY_MAX_LIMIT, offset: 200})).toEqual({
      ok: true,
      value: {limit: HISTORY_MAX_LIMIT, offset: 200},
    })
  })
})

describe('the history tool', () => {
  it('reads the page it was asked for and says which page it was', async () => {
    const seen: {limit: number; offset: number}[] = []
    const runner = runnerOver(async (q) => {
      seen.push(q)
      return [row('aa'), row('bb')]
    })
    const out = await runner({name: 'cardano_listHistory', args: {limit: 2, offset: 4}})
    expect(seen).toEqual([{limit: 2, offset: 4}])
    expect(out).toEqual({ok: true, value: {rows: [row('aa'), row('bb')], limit: 2, offset: 4}})
  })

  // ⚠️ The store's failure must not arrive as an empty history: "nothing happened on this wallet" and
  // "the read failed" are different facts, and an agent told the first will say so to a person.
  it('lets a failed read reject rather than answering with no rows', async () => {
    const runner = runnerOver(async () => {
      throw new Error('the transaction store could not be read: db closed')
    })
    await expect(runner({name: 'cardano_listHistory', args: {}})).rejects.toThrow('db closed')
  })

  it('refuses when history is not granted, naming the setting', async () => {
    const runner = runnerOver(async () => [], caps({history: false}))
    const out = await runner({name: 'cardano_listHistory', args: {}})
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.message).toContain('transaction history')
  })

  // The gate is checked before the arguments, so a withheld tool never reports an argument problem —
  // which would tell an agent to retry with different arguments forever.
  it('refuses a withheld tool before it reads the arguments', async () => {
    const runner = runnerOver(async () => [], caps({cardano: false}))
    const out = await runner({name: 'cardano_listHistory', args: {limit: 99999}})
    expect(out.ok === false && out.message).toContain('Cardano access')
  })

  it('refuses a name it does not serve', async () => {
    const out = await runnerOver(async () => [])({name: 'cardano_wipe', args: {}})
    expect(out.ok === false && out.message).toContain('cardano_wipe')
  })
})

describe('the transfer builder', () => {
  const one = {address: 'addr_test1xyz', lovelace: '2000000'}

  it('hands the parsed intent to the builder', async () => {
    const seen: unknown[] = []
    const runner = createLocalToolRunner(
      caps(),
      deps({
        buildTransfer: async (intent) => {
          seen.push(intent)
          return {ok: true, value: {submitted: true, txHash: 'ab'}}
        },
      }),
    )
    const out = await runner({name: 'cardano_buildTransfer', args: {outputs: [one], submit: true}})
    expect(seen).toEqual([
      {
        outputs: [{address: 'addr_test1xyz', amounts: new Map([['', 2_000_000n]]), lovelaceGiven: true}],
        submit: true,
      },
    ])
    expect(out).toEqual({ok: true, value: {submitted: true, txHash: 'ab'}})
  })

  // ⚠️ Nothing is built from arguments that did not parse. An agent that sent a JSON number for an
  // amount must be told so, not handed a transaction for a rounded figure.
  it('refuses before building when the arguments are wrong', async () => {
    let built = 0
    const runner = createLocalToolRunner(
      caps(),
      deps({
        buildTransfer: async () => {
          built += 1
          return {ok: true, value: {}}
        },
      }),
    )
    const out = await runner({name: 'cardano_buildTransfer', args: {outputs: [{...one, lovelace: 2_000_000}]}})
    expect(built).toBe(0)
    expect(out.ok === false && out.message).toContain('decimal STRING')
  })

  it('is withheld with the rest of Cardano when Cardano is off', async () => {
    const runner = createLocalToolRunner(caps({cardano: false}), deps())
    const out = await runner({name: 'cardano_buildTransfer', args: {outputs: [one]}})
    expect(out.ok === false && out.message).toContain('Cardano access')
  })
})

// ⚠️ The real numbers from a real session, where a local model read the CBOR itself and got both wrong.
// These are what the wallet actually holds; the model reported 200 ADA and 25 ADA.
describe('describeBalance', () => {
  it('gives the exact figure and the readable one, so neither has to be derived', () => {
    const out = describeBalance({lovelace: 10_454_176_372n, assets: []})
    expect(out.lovelace).toBe('10454176372')
    expect(out.ada).toBe('10454.176372')
  })

  it('keeps six decimal places exactly, where a float would not', () => {
    expect(describeBalance({lovelace: 1n, assets: []}).ada).toBe('0.000001')
    expect(describeBalance({lovelace: 2_000_000n, assets: []}).ada).toBe('2')
    expect(describeBalance({lovelace: 0n, assets: []}).ada).toBe('0')
    expect(describeBalance({lovelace: 999_999n, assets: []}).ada).toBe('0.999999')
  })

  // ⚠️ CIP-68 puts a four-byte label in front of the name, so a raw decode of a well-formed name still
  // starts with unprintable bytes. They are stripped for the readable name and never for the hex,
  // which is what identifies the asset.
  it('reads a CIP-68 asset name as text without touching its hex', () => {
    const out = describeBalance({
      lovelace: 0n,
      assets: [{assetId: `${'9c'.repeat(28)}.0014df104c494e4b`, quantity: 550_999_000n}],
    })
    expect(out.assets[0]?.name).toBe('LINK')
    expect(out.assets[0]?.assetNameHex).toBe('0014df104c494e4b')
    expect(out.assets[0]?.policyId).toBe('9c'.repeat(28))
    expect(out.assets[0]?.quantity).toBe('550999000')
  })

  // A nameless asset is normal, and so is one whose bytes are not text. Neither is mojibake.
  it('answers null for a name that is not text, rather than guessing', () => {
    const nameless = describeBalance({lovelace: 0n, assets: [{assetId: `${'d2'.repeat(28)}.`, quantity: 1n}]})
    expect(nameless.assets[0]?.name).toBeNull()
    const binary = describeBalance({lovelace: 0n, assets: [{assetId: `${'d2'.repeat(28)}.ff00`, quantity: 1n}]})
    expect(binary.assets[0]?.name).toBeNull()
  })

  it('reports a quantity as a string, since one does not fit a JSON number', () => {
    const out = describeBalance({lovelace: 0n, assets: [{assetId: `${'ab'.repeat(28)}.`, quantity: 2n ** 64n}]})
    expect(out.assets[0]?.quantity).toBe('18446744073709551616')
  })
})

describe('readReadUtxosArgs', () => {
  it('defaults to the whole set, one page, from the start', () => {
    const parsed = readReadUtxosArgs({})
    expect(parsed).toEqual({ok: true, value: {collateralOnly: false, limit: UTXO_DEFAULT_LIMIT, offset: 0}})
  })

  it('refuses a non-boolean collateralOnly rather than treating it as true', () => {
    // A truthy string would silently widen a collateral read to every output.
    const parsed = readReadUtxosArgs({collateralOnly: 'yes'})
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.message).toContain('collateralOnly')
  })

  it('caps the limit rather than letting one call pull an unbounded set', () => {
    const parsed = readReadUtxosArgs({limit: UTXO_MAX_LIMIT + 1})
    expect(parsed.ok).toBe(false)
  })

  it('carries a page through', () => {
    expect(readReadUtxosArgs({collateralOnly: true, limit: 10, offset: 20})).toEqual({
      ok: true,
      value: {collateralOnly: true, limit: 10, offset: 20},
    })
  })
})

describe('describeUtxos', () => {
  const utxo = (over: Record<string, unknown> = {}) => ({
    txHash: 'aa'.repeat(32),
    index: 1,
    address: 'addr_test1qsomewhere',
    lovelace: 2_500_000n,
    assets: [],
    ...over,
  })

  it('names each output as txHash#index and keeps the parts beside it', () => {
    const out = describeUtxos({total: 1, utxos: [utxo()]}, {collateralOnly: false, limit: 50, offset: 0})
    expect(out.utxos[0]?.ref).toBe(`${'aa'.repeat(32)}#1`)
    expect(out.utxos[0]?.txHash).toBe('aa'.repeat(32))
    expect(out.utxos[0]?.index).toBe(1)
  })

  it('gives the exact figure and the human one, as decimal strings', () => {
    const out = describeUtxos({total: 1, utxos: [utxo()]}, {collateralOnly: false, limit: 50, offset: 0})
    expect(out.utxos[0]?.lovelace).toBe('2500000')
    expect(typeof out.utxos[0]?.ada).toBe('string')
  })

  it('splits an asset id into policy and name, and reports a non-text name as null', () => {
    const out = describeUtxos(
      {total: 1, utxos: [utxo({assets: [{assetId: `${'bb'.repeat(28)}.ffff`, quantity: 7n}]})]},
      {collateralOnly: false, limit: 50, offset: 0},
    )
    const asset = out.utxos[0]?.assets[0]
    expect(asset?.policyId).toBe('bb'.repeat(28))
    expect(asset?.assetNameHex).toBe('ffff')
    expect(asset?.name).toBeNull()
    expect(asset?.quantity).toBe('7')
  })

  it('says how much it is NOT showing, so a page is never summed as the balance', () => {
    const out = describeUtxos({total: 130, utxos: [utxo(), utxo()]}, {collateralOnly: false, limit: 2, offset: 0})
    expect(out.total).toBe(130)
    expect(out.returned).toBe(2)
    expect(out.remaining).toBe(128)
    expect(out.truncated).toBe(true)
  })

  it('counts remaining from the offset, not from the page alone', () => {
    const out = describeUtxos({total: 10, utxos: [utxo(), utxo()]}, {collateralOnly: false, limit: 2, offset: 8})
    expect(out.remaining).toBe(0)
    expect(out.truncated).toBe(false)
  })

  it('never reports a negative remainder when the set shrank under a page', () => {
    const out = describeUtxos({total: 1, utxos: [utxo(), utxo()]}, {collateralOnly: false, limit: 50, offset: 0})
    expect(out.remaining).toBe(0)
    expect(out.truncated).toBe(false)
  })

  it('flags datum and script outputs only where they are true', () => {
    const plain = describeUtxos({total: 1, utxos: [utxo()]}, {collateralOnly: false, limit: 50, offset: 0})
    expect(plain.utxos[0]).not.toHaveProperty('hasInlineDatum')
    expect(plain.utxos[0]).not.toHaveProperty('hasScriptRef')
    expect(plain.utxos[0]).not.toHaveProperty('datumHash')

    const rich = describeUtxos(
      {total: 1, utxos: [utxo({datumHash: 'cc'.repeat(32), hasInlineDatum: true, hasScriptRef: true})]},
      {collateralOnly: false, limit: 50, offset: 0},
    )
    expect(rich.utxos[0]?.datumHash).toBe('cc'.repeat(32))
    expect(rich.utxos[0]?.hasInlineDatum).toBe(true)
    expect(rich.utxos[0]?.hasScriptRef).toBe(true)
  })

  it('marks a collateral read as one, and says nothing on an ordinary one', () => {
    expect(describeUtxos({total: 0, utxos: []}, {collateralOnly: true, limit: 50, offset: 0}).collateralOnly).toBe(true)
    expect(describeUtxos({total: 0, utxos: []}, {collateralOnly: false, limit: 50, offset: 0})).not.toHaveProperty(
      'collateralOnly',
    )
  })
})

describe('cardano_readUtxos through the runner', () => {
  it('passes the parsed page to the dep and answers the described shape', async () => {
    let seen: unknown = null
    const runner = createLocalToolRunner(
      caps(),
      deps({
        readUtxos: async (query) => {
          seen = query
          return {
            total: 3,
            utxos: [
              {
                txHash: 'ab'.repeat(32),
                index: 0,
                address: 'addr_test1qx',
                lovelace: 1_000_000n,
                assets: [],
              },
            ],
          }
        },
      }),
    )
    const out = await runner({name: 'cardano_readUtxos', args: {limit: 1, offset: 2}})
    expect(seen).toEqual({collateralOnly: false, limit: 1, offset: 2})
    expect(out.ok).toBe(true)
    if (out.ok) {
      const value = out.value as {total: number; remaining: number; utxos: readonly {ref: string}[]}
      expect(value.total).toBe(3)
      expect(value.remaining).toBe(0)
      expect(value.utxos[0]?.ref).toBe(`${'ab'.repeat(32)}#0`)
    }
  })

  it('is refused when Cardano access is not granted — the gate is at the door', async () => {
    const runner = createLocalToolRunner(caps({cardano: false}), deps())
    const out = await runner({name: 'cardano_readUtxos', args: {}})
    expect(out.ok).toBe(false)
  })

  it('refuses a bad argument before reaching the dep', async () => {
    let called = false
    const runner = createLocalToolRunner(
      caps(),
      deps({
        readUtxos: async () => {
          called = true
          return {total: 0, utxos: []}
        },
      }),
    )
    const out = await runner({name: 'cardano_readUtxos', args: {collateralOnly: 'yes'}})
    expect(out.ok).toBe(false)
    expect(called).toBe(false)
  })
})

// The two Midnight tools the app answers itself. What is worth pinning here is the same as for the
// Cardano builders: the gate is at the door, and nothing is built from arguments that did not parse.
describe('the Midnight tools through the runner', () => {
  const sources = [
    {scope: 'g1:0', pledge: '2000000'},
    {scope: 'g2:0', pledge: '4000000'},
  ]
  const recipient = 'mn_addr_test1recipient'

  it('hands the parsed co-fund intent to the builder', async () => {
    const seen: unknown[] = []
    const runner = createLocalToolRunner(
      caps(),
      deps({
        buildMidnightCoFunded: async (intent) => {
          seen.push(intent)
          return {ok: true, value: {submitted: true}}
        },
      }),
    )
    const out = await runner({name: 'midnight_buildCoFundedSend', args: {sources, recipient, submit: true}})
    expect(seen).toEqual([
      {
        sources: [
          {scope: 'g1:0', pledge: 2_000_000n},
          {scope: 'g2:0', pledge: 4_000_000n},
        ],
        recipient,
        tokenType: '00'.repeat(32),
        submit: true,
      },
    ])
    expect(out).toEqual({ok: true, value: {submitted: true}})
  })

  it('refuses before building when a pledge is a JSON number', async () => {
    let built = 0
    const runner = createLocalToolRunner(
      caps(),
      deps({
        buildMidnightCoFunded: async () => {
          built += 1
          return {ok: true, value: {}}
        },
      }),
    )
    const out = await runner({
      name: 'midnight_buildCoFundedSend',
      args: {sources: [sources[0], {scope: 'g2:0', pledge: 4_000_000}], recipient},
    })
    expect(built).toBe(0)
    expect(out.ok === false && out.message).toContain('decimal STRING')
  })

  it('passes the transaction hex through to the reader', async () => {
    const seen: string[] = []
    const runner = createLocalToolRunner(
      caps(),
      deps({
        readMidnightTransaction: async (txHex) => {
          seen.push(txHex)
          return {ok: true, value: {understood: false}}
        },
      }),
    )
    // Lowercased by the hex reader, which is what every downstream comparison expects.
    const out = await runner({name: 'midnight_readTransaction', args: {transaction: 'ABCD'}})
    expect(seen).toEqual(['abcd'])
    expect(out).toEqual({ok: true, value: {understood: false}})
  })

  // ⚠️ Empty bytes are refused rather than read: `txFacts` on nothing is a decode failure, and the
  // agent would be told the transaction is unreadable when in fact it sent none.
  it('refuses an empty or non-hex transaction without reading it', async () => {
    let read = 0
    const runner = createLocalToolRunner(
      caps(),
      deps({
        readMidnightTransaction: async () => {
          read += 1
          return {ok: true, value: {}}
        },
      }),
    )
    expect((await runner({name: 'midnight_readTransaction', args: {transaction: ''}})).ok).toBe(false)
    expect((await runner({name: 'midnight_readTransaction', args: {transaction: 'zz'}})).ok).toBe(false)
    expect(read).toBe(0)
  })

  it('is withheld with the rest of Midnight when Midnight is off', async () => {
    const runner = createLocalToolRunner(caps({midnight: false}), deps())
    for (const name of ['midnight_buildCoFundedSend', 'midnight_readTransaction']) {
      const out = await runner({name, args: {sources, recipient, transaction: 'ab'}})
      expect(out.ok === false && out.message).toContain('Midnight access')
    }
  })
})

describe('midnight_readSyncStatus', () => {
  it('reports the age in seconds', async () => {
    const runner = createLocalToolRunner(caps(), deps({midnightSyncAgeMs: () => 90_000}))
    const outcome = await runner({name: 'midnight_readSyncStatus', args: {}})
    expect(outcome).toEqual({
      ok: true,
      value: {
        syncedSecondsAgo: 90,
        everSynced: true,
        shielded: {state: 'no-network', scannedToBlock: null, chainTipBlock: null, blocksBehind: null},
      },
    })
  })

  // ⚠️ Never synced is not "zero seconds ago", and an agent must be able to tell the two apart before
  // it acts on a balance.
  it('reports never-synced as null rather than zero', async () => {
    const runner = createLocalToolRunner(caps(), deps({midnightSyncAgeMs: () => null}))
    const outcome = await runner({name: 'midnight_readSyncStatus', args: {}})
    expect(outcome).toEqual({
      ok: true,
      value: {
        syncedSecondsAgo: null,
        everSynced: false,
        shielded: {state: 'no-network', scannedToBlock: null, chainTipBlock: null, blocksBehind: null},
      },
    })
  })
})

describe('listOutcomes', () => {
  it('is empty when the agent has handed nothing off', async () => {
    forgetOutcomes()
    const runner = createLocalToolRunner(caps(), deps({}))
    const outcome = await runner({name: 'cardano_listOutcomes', args: {}})
    expect(outcome).toEqual({ok: true, value: {outcomes: []}})
  })

  // The rule the channel exists for: broadcast is not landed, and only the chain settles it.
  it('reports a submitted transaction the chain has not decided as undecided', async () => {
    forgetOutcomes()
    recordOutcome({txHash: 'aa', chain: 'cardano', stage: 'submitted', at: 1})
    const runner = createLocalToolRunner(caps(), deps({txStatus: async () => 'pending'}))
    const outcome = await runner({name: 'cardano_listOutcomes', args: {}})

    expect(outcome).toMatchObject({ok: true, value: {outcomes: [{txHash: 'aa', landed: null}]}})
  })

  it('reports a confirmed transaction as landed', async () => {
    forgetOutcomes()
    recordOutcome({txHash: 'aa', chain: 'cardano', stage: 'submitted', at: 1})
    const runner = createLocalToolRunner(caps(), deps({txStatus: async () => 'confirmed'}))
    const outcome = await runner({name: 'cardano_listOutcomes', args: {}})

    expect(outcome).toMatchObject({ok: true, value: {outcomes: [{landed: true}]}})
  })

  // A transaction that never reached the chain has nothing to look up, and asking would invent a
  // question the wallet cannot answer.
  it('does not look up a status for a transaction that was never submitted', async () => {
    forgetOutcomes()
    recordOutcome({txHash: 'aa', chain: 'cardano', stage: 'declined', at: 1})
    let asked = 0
    const runner = createLocalToolRunner(
      caps(),
      deps({
        txStatus: async () => {
          asked++
          return 'unknown'
        },
      }),
    )
    await runner({name: 'cardano_listOutcomes', args: {}})
    expect(asked).toBe(0)
  })

  // ⚠️ Cardano only. A device-built Midnight transaction has no hash until the sponsor binds it, so a
  // Midnight outcome has nothing to be keyed by — the tool is deliberately absent rather than empty.
  it('reports only Cardano outcomes', async () => {
    forgetOutcomes()
    recordOutcome({txHash: 'aa', chain: 'cardano', stage: 'submitted', at: 1})
    recordOutcome({txHash: 'bb', chain: 'midnight', stage: 'submitted', at: 2})
    const runner = createLocalToolRunner(caps(), deps({txStatus: async () => 'confirmed'}))

    const cardano = await runner({name: 'cardano_listOutcomes', args: {}})
    expect(cardano).toMatchObject({value: {outcomes: [{txHash: 'aa'}]}})
  })
})

describe('describeShieldedFreshness', () => {
  it('names no-network apart from never-synced', () => {
    // ⚠️ "This build serves no Midnight network" and "this wallet has never scanned" are different
    // facts, and an agent acts differently on them: the first cannot be fixed by calling syncShielded.
    expect(describeShieldedFreshness(null).state).toBe('no-network')
    expect(describeShieldedFreshness({kind: 'never-synced'}).state).toBe('never-synced')
  })

  it('gives a behind rail its distance, so nobody has to subtract', () => {
    expect(describeShieldedFreshness({kind: 'behind', cursor: 100, tip: 940})).toEqual({
      state: 'behind',
      scannedToBlock: 100,
      chainTipBlock: 940,
      blocksBehind: 840,
    })
  })

  it('reports a current rail as zero behind, not as unknown', () => {
    expect(describeShieldedFreshness({kind: 'current', cursor: 940}).blocksBehind).toBe(0)
  })

  it('keeps blocksBehind null when the tip could not be read', () => {
    // ⚠️ Not `0`. An unreadable tip means the distance is unknown, and reporting zero would tell an
    // agent the rail is current — the one claim this whole answer exists to stop being made silently.
    const described = describeShieldedFreshness({kind: 'unknown', cursor: 100, reason: 'timeout'})
    expect(described.state).toBe('unknown')
    expect(described.blocksBehind).toBeNull()
    expect(described.scannedToBlock).toBe(100)
  })
})

describe('midnight_syncShielded', () => {
  it('refuses rather than claiming success when there is no Midnight network', async () => {
    const runner = createLocalToolRunner(caps(), deps({syncShielded: async () => null}))
    const outcome = await runner({name: 'midnight_syncShielded', args: {}})
    expect(outcome.ok).toBe(false)
  })

  it('reports where the walk got to, and whether it finished', async () => {
    const runner = createLocalToolRunner(
      caps(),
      deps({
        syncShielded: async () => ({
          scannedToBlock: 852_477,
          blocksScanned: 392,
          transactionsApplied: 36,
          caughtUp: true,
        }),
      }),
    )
    const outcome = await runner({name: 'midnight_syncShielded', args: {}})
    expect(outcome).toEqual({
      ok: true,
      value: {scannedToBlock: 852_477, blocksScanned: 392, transactionsApplied: 36, caughtUp: true},
    })
  })

  it('is withheld when the wallet has not granted Midnight access', async () => {
    const runner = createLocalToolRunner({...caps(), midnight: false}, deps({}))
    const outcome = await runner({name: 'midnight_syncShielded', args: {}})
    expect(outcome.ok).toBe(false)
  })
})

describe('midnight_readSyncStatus', () => {
  it('answers per rail, because only one of them refreshes on its own', async () => {
    // ⚠️ The defect this fixes: `syncedSecondsAgo` is fed by `recordSync`, which only the *unshielded*
    // sync calls. A wallet seconds-fresh on that rail can be arbitrarily far behind on this one, and
    // the tool used to describe itself as covering "this wallet's Midnight balances".
    const runner = createLocalToolRunner(
      caps(),
      deps({
        midnightSyncAgeMs: () => 3_000,
        shieldedFreshness: async () => ({kind: 'behind', cursor: 10, tip: 4_010}),
      }),
    )
    const outcome = await runner({name: 'midnight_readSyncStatus', args: {}})
    expect(outcome).toEqual({
      ok: true,
      value: {
        syncedSecondsAgo: 3,
        everSynced: true,
        shielded: {state: 'behind', scannedToBlock: 10, chainTipBlock: 4_010, blocksBehind: 4_000},
      },
    })
  })
})
