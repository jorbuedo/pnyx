import {Cip113} from '@evolution-sdk/cip113'
import {Assets} from '@evolution-sdk/evolution'
import {TxHashHex} from '@evolution-sdk/review/Brands'
import {describe, expect, it} from 'vitest'
import {composeTransferPlan, type DecodedHolding, selectHoldings, type TransferPlanInput} from './transfer-plan'

const POLICY = '16b37cfebd14a0d3da5e8738333b21a145a9f6429f396199d22b67a5'
const NAME = '54455354'
const KEY = `${POLICY}.${NAME}`
const SUB_HASH = 'ab'.repeat(28)
const OUR_STAKE = 'e557890352095f1cf6fd2b7d1a28e3c3cb029f48cf34ff890a28d176'
const THEIR_STAKE = 'cd'.repeat(28)

/**
 * ⚠️ The UTxO's bag is a REAL `Assets`, where this used to be `ValueHex('82')` — a stand-in that
 * decoded to nothing, because the brand is a cast and the composer never looked inside it. The
 * plan carries bags now, so the double and the value agree.
 */
const holding = (index: number, amount: bigint): DecodedHolding => ({
  utxo: {
    txHash: TxHashHex('aa'.repeat(32)),
    index,
    assets: Assets.fromRecord({lovelace: 2_000_000n, [KEY]: amount}),
    owner: {kind: 'key', hashHex: OUR_STAKE},
  },
  lovelace: 2_000_000n,
  assets: new Map([[KEY, amount]]),
})

/** A plan output's contents as `[lovelace, {unit: amount}]`, for comparing against expectations. */
const contents = (o: {readonly assets: Assets.Assets}) =>
  [
    Assets.lovelaceOf(o.assets),
    Object.fromEntries(
      Assets.getUnits(o.assets)
        .filter((u) => u !== 'lovelace')
        .map((u) => [`${u.slice(0, 56)}.${u.slice(56)}`, Assets.getByUnit(o.assets, u)]),
    ),
  ] as const

const node = {
  txHash: 'bb'.repeat(32),
  index: 0,
  node: {keyHex: POLICY, transferLogicScript: {kind: 'script', hashHex: SUB_HASH}},
} as unknown as Cip113.RegistryNodeRef

const base = (over: Partial<TransferPlanInput> = {}): TransferPlanInput =>
  ({
    deployment: {plbScriptHashHex: '33'.repeat(28), transferScriptHashHex: 'ba'.repeat(28), version: Cip113.LATEST},
    scripts: {plbScriptHex: 'aa', transferScriptHex: 'bb'},
    registryNodes: [node],
    protocolParamsRef: {txHash: 'cc'.repeat(32), index: 0},
    ourHoldings: [holding(0, 1000n)],
    intents: [{policyHex: POLICY, assetNameHex: NAME, quantity: 100n, recipient: {kind: 'key', hashHex: THEIR_STAKE}}],
    substandards: new Map([
      [SUB_HASH, {scriptHashHex: SUB_HASH, scriptHex: 'ee', redeemerDataHex: 'd8', exUnits: [1n, 1n]}],
    ]),
    fundingInputs: [{txHash: 'dd'.repeat(32), index: 0, assets: Assets.fromLovelace(10_000_000n)}],
    collateral: [{txHash: 'dd'.repeat(32), index: 0}],
    changeAddressHex: '00ab',
    costModels: [],
    network: 0,
    params: {} as never,
    // Echoes the shape back so a test can assert what was actually asked for — the point of the
    // rewire is that outputs are counted, not assumed from the inputs.
    budgetsFor: (inputs: number, outputs: number) => ({
      plb: [BigInt(inputs), 1n] as const,
      transfer: [BigInt(outputs), 1n] as const,
    }),
    // Modelled, not fixed: a floor that ignored the recipient and the assets is the bug this
    // replaced — one figure shared across outputs is wrong for all but one of them.
    minAdaForRecipient: (recipient: Cip113.Credential, assets: ReadonlyMap<string, bigint>) =>
      1_000_000n + BigInt(recipient.hashHex.length) + BigInt(assets.size) * 100_000n,
    ...over,
  }) as unknown as TransferPlanInput

describe('composeTransferPlan', () => {
  it('composes a request when everything is present', () => {
    const plan = composeTransferPlan(base(), 74)
    expect(plan.kind).toBe('ready')
    if (plan.kind !== 'ready') return
    expect(plan.movedPolicies).toEqual([POLICY])
    expect(plan.request.plbInputs).toHaveLength(1)
    // The recipient's output, then the 900 left on the spent UTxO going back to our own wallet.
    expect(plan.request.plbOutputs).toHaveLength(2)
    expect(plan.request.plbOutputs[0]?.recipient).toEqual({kind: 'key', hashHex: THEIR_STAKE})
    expect(plan.request.plbOutputs[1]?.recipient).toEqual({kind: 'key', hashHex: OUR_STAKE})
  })

  it('refuses without a substandard rather than building something that fails at submit', () => {
    // ⚠️ The registry names transfer_logic by hash; the script is the issuer's and is not published
    // with the deployment. Fabricating a redeemer would fail the user's transaction after signing.
    const plan = composeTransferPlan(base({substandards: new Map()}), 74)
    expect(plan).toMatchObject({kind: 'incomplete', reason: 'missing-substandard'})
  })

  it('refuses when the wallet has no ordinary ADA for the fee', () => {
    // Smart-wallet ADA cannot pay a fee — the address's payment credential is the PLB script.
    const plan = composeTransferPlan(base({fundingInputs: []}), 74)
    expect(plan).toMatchObject({kind: 'incomplete', reason: 'no-funding'})
  })

  it('refuses rather than sending less than asked', () => {
    const plan = composeTransferPlan(base({ourHoldings: [holding(0, 10n)]}), 74)
    expect(plan).toMatchObject({kind: 'incomplete', reason: 'insufficient-holdings'})
  })

  it('refuses rather than truncating past the input ceiling', () => {
    const many = Array.from({length: 20}, (_, i) => holding(i, 10n))
    const plan = composeTransferPlan(base({ourHoldings: many}), 5)
    expect(plan).toMatchObject({kind: 'incomplete', reason: 'too-many-inputs'})
  })

  it('gives one output per recipient, not one per intent', () => {
    // Two intents to the same person is one output. Paying min-ADA twice for one destination is
    // real money.
    const plan = composeTransferPlan(
      base({
        intents: [
          {policyHex: POLICY, assetNameHex: NAME, quantity: 50n, recipient: {kind: 'key', hashHex: THEIR_STAKE}},
          {policyHex: POLICY, assetNameHex: NAME, quantity: 30n, recipient: {kind: 'key', hashHex: THEIR_STAKE}},
        ],
      }),
      74,
    )
    expect(plan.kind).toBe('ready')
    if (plan.kind !== 'ready') return
    const theirs = plan.request.plbOutputs.filter((o) => o.recipient.hashHex === THEIR_STAKE)
    expect(theirs).toHaveLength(1)
    expect(contents(theirs[0]!)[1]).toEqual({[KEY]: 80n})
  })

  it('carries the floor measured for that recipient, not one shared across outputs', () => {
    // Preview rejected a transfer BabbageOutputTooSmallUTxO because every output got the same
    // constant. Each output must carry what its own address and assets require.
    const other = 'ef'.repeat(28)
    const plan = composeTransferPlan(
      base({
        minAdaForRecipient: (recipient) => (recipient.hashHex === THEIR_STAKE ? 1_163_700n : 2_000_000n),
        intents: [
          {policyHex: POLICY, assetNameHex: NAME, quantity: 50n, recipient: {kind: 'key', hashHex: THEIR_STAKE}},
          {policyHex: POLICY, assetNameHex: NAME, quantity: 30n, recipient: {kind: 'key', hashHex: other}},
        ],
      }),
      74,
    )
    expect(plan.kind).toBe('ready')
    if (plan.kind !== 'ready') return
    expect(plan.request.plbOutputs.map(contents)).toEqual([
      [1_163_700n, {[KEY]: 50n}],
      [2_000_000n, {[KEY]: 30n}],
      [2_000_000n, {[KEY]: 920n}],
    ])
  })

  it('returns what the spent UTxO held over to our own smart wallet', () => {
    // ⚠️ Without this output the leftover falls through to the builder's change, which goes to an
    // ordinary key address — out of the CIP-113 regime the transfer scripts exist to enforce.
    const plan = composeTransferPlan(base(), 74)
    expect(plan.kind).toBe('ready')
    if (plan.kind !== 'ready') return
    const ours = plan.request.plbOutputs.filter((o) => o.recipient.hashHex === OUR_STAKE)
    expect(ours).toHaveLength(1)
    expect(contents(ours[0]!)[1]).toEqual({[KEY]: 900n})
  })

  it('returns a policy it never moved but had to spend', () => {
    // One smart-wallet UTxO can hold several policies, so moving one picks the others up. They
    // leave the regime just as surely as the moved policy's leftovers if nothing returns them.
    const other = `${'77'.repeat(28)}.${NAME}`
    const plan = composeTransferPlan(
      base({
        ourHoldings: [
          {
            ...holding(0, 1000n),
            assets: new Map([
              [KEY, 1000n],
              [other, 42n],
            ]),
          },
        ],
      }),
      74,
    )
    expect(plan.kind).toBe('ready')
    if (plan.kind !== 'ready') return
    const ours = plan.request.plbOutputs.find((o) => o.recipient.hashHex === OUR_STAKE)
    expect(contents(ours!)[1]).toEqual({[other]: 42n, [KEY]: 900n})
  })

  it('adds no output when the recipients take everything', () => {
    // The lovelace that sat with the tokens is then free to return as ordinary change — recovering
    // it is the point of spending the UTxO, and ADA is not programmable.
    const plan = composeTransferPlan(
      base({
        ourHoldings: [holding(0, 100n)],
        intents: [
          {policyHex: POLICY, assetNameHex: NAME, quantity: 100n, recipient: {kind: 'key', hashHex: THEIR_STAKE}},
        ],
      }),
      74,
    )
    expect(plan.kind).toBe('ready')
    if (plan.kind !== 'ready') return
    expect(plan.request.plbOutputs).toHaveLength(1)
    expect(plan.request.plbOutputs[0]?.recipient).toEqual({kind: 'key', hashHex: THEIR_STAKE})
  })

  it('refuses when the chosen UTxOs sit in different smart wallets', () => {
    // There would be no single owner to return the remainder to, and picking one would put a
    // user's tokens in a stranger's wallet.
    const foreign = {
      ...holding(1, 1000n),
      utxo: {...holding(1, 1000n).utxo, owner: {kind: 'key', hashHex: 'aa'.repeat(28)}},
    } as DecodedHolding
    const plan = composeTransferPlan(
      base({
        ourHoldings: [holding(0, 60n), foreign],
        intents: [
          {policyHex: POLICY, assetNameHex: NAME, quantity: 100n, recipient: {kind: 'key', hashHex: THEIR_STAKE}},
        ],
      }),
      74,
    )
    expect(plan).toMatchObject({kind: 'incomplete', reason: 'mixed-owners'})
  })

  it('budgets for the outputs it actually emits, not for the inputs', () => {
    // ⚠️ The rejection of 2026-08-16. PLG is charged per output as well as per input, and a
    // transfer that returns a remainder emits one more output than it has recipients. Asking for
    // a budget before the shape was known under-funded the script and the node refused it.
    const plan = composeTransferPlan(base(), 74)
    expect(plan.kind).toBe('ready')
    if (plan.kind !== 'ready') return
    expect(plan.request.plbInputs).toHaveLength(1)
    expect(plan.request.plbOutputs).toHaveLength(2)
    // plb tuple carries the input count, transfer the output count — see the fixture.
    expect(plan.request.plbInputs[0]?.exUnits[0]).toBe(1n)
    expect(plan.request.transferExUnits[0]).toBe(2n)
  })

  it('refuses a shape whose framework cost will not fit', () => {
    const plan = composeTransferPlan(base({budgetsFor: () => null}), 74)
    expect(plan).toMatchObject({kind: 'incomplete', reason: 'over-budget'})
  })

  it('gives every recipient an output, not just the first', () => {
    // ⚠️ The send flow read `state.targets[0]` and mapped the whole basket to it, so a transfer to
    // two people paid one of them and returned the rest as change — a valid transaction that did
    // half of what was asked. The plan always handled this; nothing ever passed it two intents.
    const second = 'ef'.repeat(28)
    const plan = composeTransferPlan(
      base({
        intents: [
          {policyHex: POLICY, assetNameHex: NAME, quantity: 100n, recipient: {kind: 'key', hashHex: THEIR_STAKE}},
          {policyHex: POLICY, assetNameHex: NAME, quantity: 250n, recipient: {kind: 'key', hashHex: second}},
        ],
      }),
      74,
    )
    expect(plan.kind).toBe('ready')
    if (plan.kind !== 'ready') return
    expect(plan.request.plbOutputs.map((o) => o.recipient.hashHex)).toEqual([THEIR_STAKE, second, OUR_STAKE])
    expect(contents(plan.request.plbOutputs[0]!)[1]).toEqual({[KEY]: 100n})
    expect(contents(plan.request.plbOutputs[1]!)[1]).toEqual({[KEY]: 250n})
    // 1000 held, 350 moved.
    expect(contents(plan.request.plbOutputs[2]!)[1]).toEqual({[KEY]: 650n})
    // And the budget follows the real output count, which two recipients change.
    expect(plan.request.transferExUnits[0]).toBe(3n)
  })

  it('refuses when an output floor cannot be computed', () => {
    // `null` from the codec is "unknown", never zero — funding an output from a guessed floor is
    // exactly what the ledger rejected.
    const plan = composeTransferPlan(base({minAdaForRecipient: () => null}), 74)
    expect(plan).toMatchObject({kind: 'incomplete', reason: 'unencodable-output'})
  })

  it('dedupes substandards by script hash', () => {
    // Several tokens from one issuer share a transfer-logic script; listing it twice pays twice.
    const other = `${'99'.repeat(28)}`
    const plan = composeTransferPlan(
      base({
        registryNodes: [node, {...node, node: {...node.node, keyHex: other}} as unknown as Cip113.RegistryNodeRef],
        ourHoldings: [
          {
            ...holding(0, 1000n),
            assets: new Map([
              [KEY, 1000n],
              [`${other}.${NAME}`, 1000n],
            ]),
          },
        ],
        intents: [
          {policyHex: POLICY, assetNameHex: NAME, quantity: 1n, recipient: {kind: 'key', hashHex: THEIR_STAKE}},
          {policyHex: other, assetNameHex: NAME, quantity: 1n, recipient: {kind: 'key', hashHex: THEIR_STAKE}},
        ],
      }),
      74,
    )
    expect(plan.kind).toBe('ready')
    if (plan.kind !== 'ready') return
    expect(plan.movedPolicies).toHaveLength(2)
    expect(plan.request.substandards).toHaveLength(1)
  })
})

describe('selectHoldings', () => {
  it('skips a holding that contributes nothing to what is being moved', () => {
    // Every extra input costs a script execution. Taking one that holds none of the moved asset
    // buys nothing and eats the per-transaction input ceiling.
    const irrelevant: DecodedHolding = {...holding(9, 0n), assets: new Map([['other.aa', 500n]])}
    const chosen = selectHoldings(
      [irrelevant, holding(0, 200n)],
      [{policyHex: POLICY, assetNameHex: NAME, quantity: 100n, recipient: {kind: 'key', hashHex: THEIR_STAKE}}],
    )
    expect(chosen?.map((c) => c.utxo.index)).toEqual([0])
  })

  it('accumulates across UTxOs until covered', () => {
    const chosen = selectHoldings(
      [holding(0, 60n), holding(1, 60n)],
      [{policyHex: POLICY, assetNameHex: NAME, quantity: 100n, recipient: {kind: 'key', hashHex: THEIR_STAKE}}],
    )
    expect(chosen).toHaveLength(2)
  })

  it('returns null rather than a partial selection', () => {
    expect(
      selectHoldings(
        [holding(0, 10n)],
        [{policyHex: POLICY, assetNameHex: NAME, quantity: 100n, recipient: {kind: 'key', hashHex: THEIR_STAKE}}],
      ),
    ).toBeNull()
  })
})
