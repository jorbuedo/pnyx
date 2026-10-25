import {Assets as EvAssets} from '@evolution-sdk/evolution'
import {Plan} from '@evolution-sdk/plan'
import {AddressHex, TxHashHex} from '@evolution-sdk/review/Brands'
import {layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import {Certs} from '@pnyx/cardano-core'
import {Effect, Exit} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import {resolveCardanoSigningPaths, ScriptIndexMismatchError} from './signing-paths.js'
import type {OwnedSigningKey, ResolvedInput} from './types.js'

const PARAMS: Plan.ProtocolParams = {
  minFeeA: 44n,
  minFeeB: 155_381n,
  coinsPerUtxoByte: 4310n,
  keyDeposit: 2_000_000n,
  poolDeposit: 500_000_000n,
  drepDeposit: 500_000_000n,
  maxValueSize: 5000n,
  maxTxSize: 16_384n,
}

const KEY_HASH_A = 'aa'.repeat(28)
const SCRIPT_HASH_0 = '10'.repeat(28)
const SCRIPT_HASH_3 = '30'.repeat(28)
const STAKE_SCRIPT_HASH = '99'.repeat(28)

/** Base address with a *script* payment credential — a shared wallet's address. */
const scriptAddressHex = (paymentScriptHashHex: string): AddressHex =>
  AddressHex(`30${paymentScriptHashHex}${STAKE_SCRIPT_HASH}`)
/** Base address with a key payment credential — an ordinary wallet's. */
const keyAddressHex = (paymentKeyHashHex: string): AddressHex => AddressHex(`00${paymentKeyHashHex}${'88'.repeat(28)}`)

const TX_A = TxHashHex('aa'.repeat(32))
const TX_B = TxHashHex('bb'.repeat(32))

const resolved = (txHashHex: string, addressHex: string): ResolvedInput => ({
  txHashHex,
  index: 0,
  addressHex,
  coin: 1_000_000n,
  tokens: [],
})

describe('resolveCardanoSigningPaths — script spends', () => {
  let bodyTwoInputs: string

  beforeAll(async () => {
    // One body spending both UTxOs, so the resolver sees two inputs and the only
    // thing that varies between the cases below is which addresses they sit at.
    const built = Plan.buildUnsigned({
      inputs: [],
      mandatoryInputs: [
        {txHash: TX_A, index: 0, assets: EvAssets.fromLovelace(10_000_000n)},
        {txHash: TX_B, index: 0, assets: EvAssets.fromLovelace(10_000_000n)},
      ],
      outputs: [{addressHex: keyAddressHex('11'.repeat(28)), assets: EvAssets.fromLovelace(5_000_000n)}],
      changeAddressHex: scriptAddressHex(SCRIPT_HASH_0),
      params: PARAMS,
      signerCount: 2,
    })
    bodyTwoInputs = built.bodyHex
  })

  const run = (
    inputs: readonly ResolvedInput[],
    scriptAuthorities?: readonly {readonly scriptHashHex: string; readonly signerKeyHashes: readonly string[]}[],
    owned: readonly OwnedSigningKey[] = [{keyHashHex: KEY_HASH_A, path: "m/1854'/1815'/0'/0/0"}],
  ) =>
    Effect.runPromiseExit(
      Effect.provide(resolveCardanoSigningPaths(bodyTwoInputs, owned, inputs, scriptAuthorities), EvolutionDecodeLayer),
    )

  it('resolves our own path from the leaves the script names, which no address exposes', async () => {
    const exit = await run(
      [resolved(TX_A, scriptAddressHex(SCRIPT_HASH_0)), resolved(TX_B, scriptAddressHex(SCRIPT_HASH_0))],
      [
        {
          scriptHashHex: SCRIPT_HASH_0,
          signerKeyHashes: [KEY_HASH_A, 'bb'.repeat(28)],
        },
      ],
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.signingPaths).toEqual(["m/1854'/1815'/0'/0/0"])
      expect(exit.value.requiredKeyHashes).toContain('bb'.repeat(28))
    }
  })

  it('spends two of the wallet own scripts in one transaction, resolving a path at each', async () => {
    // The ledger has always allowed this — a script and a witness set per index —
    // and an ordinary key wallet already does it across its own addresses. What
    // used to refuse it was our envelope carrying a single index, not the chain.
    const exit = await run(
      [resolved(TX_A, scriptAddressHex(SCRIPT_HASH_0)), resolved(TX_B, scriptAddressHex(SCRIPT_HASH_3))],
      [
        {scriptHashHex: SCRIPT_HASH_0, signerKeyHashes: [KEY_HASH_A]},
        {scriptHashHex: SCRIPT_HASH_3, signerKeyHashes: ['a3'.repeat(28)]},
      ],
      [
        {keyHashHex: KEY_HASH_A, path: "m/1854'/1815'/0'/0/0"},
        {keyHashHex: 'a3'.repeat(28), path: "m/1854'/1815'/0'/0/3"},
      ],
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.signingPaths).toEqual(["m/1854'/1815'/0'/0/0", "m/1854'/1815'/0'/0/3"])
    }
  })

  it('requires only the leaves of the scripts actually spent from', async () => {
    // An index the transaction does not touch owes no signatures. Naming its
    // co-signers would leave the quorum panel waiting on people whose witness the
    // ledger does not want, and the transaction never submits.
    const exit = await run(
      [resolved(TX_A, scriptAddressHex(SCRIPT_HASH_0)), resolved(TX_B, scriptAddressHex(SCRIPT_HASH_0))],
      [
        {scriptHashHex: SCRIPT_HASH_0, signerKeyHashes: [KEY_HASH_A]},
        {scriptHashHex: SCRIPT_HASH_3, signerKeyHashes: ['a3'.repeat(28)]},
      ],
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      expect(exit.value.requiredKeyHashes).toContain(KEY_HASH_A)
      expect(exit.value.requiredKeyHashes).not.toContain('a3'.repeat(28))
    }
  })

  it('refuses a script the wallet holds no leaves for at all', async () => {
    // Still refused, and it has to be: this is a UTxO the wallet cannot spend.
    // Signing anyway produces a transaction that gathers its whole quorum and is
    // rejected, with nothing along the way saying why.
    const exit = await run(
      [resolved(TX_A, scriptAddressHex(SCRIPT_HASH_0)), resolved(TX_B, scriptAddressHex(SCRIPT_HASH_3))],
      [{scriptHashHex: SCRIPT_HASH_0, signerKeyHashes: [KEY_HASH_A]}],
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(String(exit.cause)).toContain('ScriptIndexMismatchError')
    }
  })

  it('names the foreign script it refused over, so the failure can be acted on', async () => {
    // `Effect.either` for the typed failure — reading a rejected runPromise
    // gives the FiberFailure wrapper instead.
    const result = await Effect.runPromise(
      Effect.either(
        Effect.provide(
          resolveCardanoSigningPaths(
            bodyTwoInputs,
            [],
            [resolved(TX_A, scriptAddressHex(SCRIPT_HASH_3))],
            [{scriptHashHex: SCRIPT_HASH_0, signerKeyHashes: [KEY_HASH_A]}],
          ),
          EvolutionDecodeLayer,
        ),
      ),
    )
    if (result._tag !== 'Left') throw new Error('expected a refusal')
    expect(result.left).toBeInstanceOf(ScriptIndexMismatchError)
    if (result.left instanceof ScriptIndexMismatchError) {
      expect(result.left.expectedScriptHashHexes).toEqual([SCRIPT_HASH_0])
      expect(result.left.foreignScriptHashHexes).toEqual([SCRIPT_HASH_3])
    }
  })

  it('leaves an ordinary wallet alone — no authority, no refusal', async () => {
    // The same body, both inputs at script addresses we know nothing about: a
    // key wallet passes no authority, so script inputs contribute nothing and
    // nothing is refused.
    const exit = await run([
      resolved(TX_A, scriptAddressHex(SCRIPT_HASH_0)),
      resolved(TX_B, scriptAddressHex(SCRIPT_HASH_3)),
    ])
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value.signingPaths).toEqual([])
  })

  it('still requires a key input credential alongside a script one', async () => {
    const exit = await run(
      [resolved(TX_A, scriptAddressHex(SCRIPT_HASH_0)), resolved(TX_B, keyAddressHex(KEY_HASH_A))],
      [{scriptHashHex: SCRIPT_HASH_0, signerKeyHashes: []}],
    )
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) expect(exit.value.requiredKeyHashes).toContain(KEY_HASH_A)
  })
})

describe('resolveCardanoSigningPaths — a script stake credential', () => {
  const STAKE_LEAF_OURS = 'e1'.repeat(28)
  const STAKE_LEAF_THEIRS = 'e2'.repeat(28)
  const OUR_STAKE_PATH = "m/1854'/1815'/0'/2/0"
  const POOL_HASH = 'f0'.repeat(28)
  /** Testnet reward address with a *script* stake credential (header type 15). */
  const scriptRewardHex = (stakeScriptHashHex: string): string => `f0${stakeScriptHashHex}`

  const STAKE_AUTHORITY = {scriptHashHex: STAKE_SCRIPT_HASH, signerKeyHashes: [STAKE_LEAF_OURS, STAKE_LEAF_THEIRS]}
  const OWNED: readonly OwnedSigningKey[] = [
    {keyHashHex: KEY_HASH_A, path: "m/1854'/1815'/0'/0/0"},
    {keyHashHex: STAKE_LEAF_OURS, path: OUR_STAKE_PATH},
  ]

  let delegationBody: string
  let withdrawalBody: string
  let keyCredDelegationBody: string
  let spendBody: string

  beforeAll(async () => {
    const build = (over: Partial<Plan.UnsignedCardanoPlan>): string =>
      Plan.buildUnsigned({
        inputs: [],
        mandatoryInputs: [{txHash: TX_A, index: 0, assets: EvAssets.fromLovelace(20_000_000n)}],
        outputs: [],
        changeAddressHex: scriptAddressHex(SCRIPT_HASH_0),
        params: PARAMS,
        signerCount: 4,
        ...over,
      }).bodyHex
    delegationBody = build({certificates: [Effect.runSync(Certs.stakeDelegation(STAKE_SCRIPT_HASH, POOL_HASH, true))]})
    keyCredDelegationBody = build({certificates: [Effect.runSync(Certs.stakeDelegation(STAKE_SCRIPT_HASH, POOL_HASH))]})
    withdrawalBody = build({withdrawals: [{rewardAcctHex: scriptRewardHex(STAKE_SCRIPT_HASH), amount: 1_000_000n}]})
    spendBody = build({
      outputs: [{addressHex: keyAddressHex('11'.repeat(28)), assets: EvAssets.fromLovelace(5_000_000n)}],
    })
  })

  // No default for `stakeAuthority`: a default would be re-triggered by passing
  // `undefined` explicitly, so the "key wallet, no authority" case below would
  // silently have tested the authority case instead. It did, until this was fixed.
  const run = (bodyHex: string, stakeAuthority: typeof STAKE_AUTHORITY | undefined) =>
    Effect.runPromise(
      Effect.provide(
        resolveCardanoSigningPaths(
          bodyHex,
          OWNED,
          [resolved(TX_A, scriptAddressHex(SCRIPT_HASH_0))],
          [{scriptHashHex: SCRIPT_HASH_0, signerKeyHashes: [KEY_HASH_A]}],
          stakeAuthority,
        ),
        EvolutionDecodeLayer,
      ),
    )

  it('resolves our stake path from the delegation script leaves', async () => {
    // Nothing in the body says what they are: the certificate carries a script
    // hash, so `Analyze` skips it as a required signer and the address exposes
    // nothing either. Without the authority the delegation goes out missing the
    // one witness that makes it a delegation.
    const result = await run(delegationBody, STAKE_AUTHORITY)
    expect(result.signingPaths).toContain(OUR_STAKE_PATH)
    expect(result.requiredKeyHashes).toContain(STAKE_LEAF_THEIRS)
  })

  it('resolves it for a withdrawal too — same credential, same script', async () => {
    const result = await run(withdrawalBody, STAKE_AUTHORITY)
    expect(result.signingPaths).toContain(OUR_STAKE_PATH)
  })

  it('asks for no stake witness on an ordinary spend from the same wallet', async () => {
    // The authority is passed on every request, so this is the guard that keeps a
    // send from producing a witness the transaction has no use for.
    const result = await run(spendBody, STAKE_AUTHORITY)
    expect(result.signingPaths).not.toContain(OUR_STAKE_PATH)
    expect(result.requiredKeyHashes).not.toContain(STAKE_LEAF_OURS)
  })

  it('ignores a certificate over the same hash under a KEY credential', async () => {
    // Same 28 bytes, different credential type — a different account entirely,
    // and not one this script authorises.
    const result = await run(keyCredDelegationBody, STAKE_AUTHORITY)
    expect(result.signingPaths).not.toContain(OUR_STAKE_PATH)
  })

  it('ignores a delegation of somebody else script stake credential', async () => {
    const result = await run(delegationBody, {scriptHashHex: '77'.repeat(28), signerKeyHashes: [STAKE_LEAF_OURS]})
    expect(result.signingPaths).not.toContain(OUR_STAKE_PATH)
  })

  it('leaves a key wallet untouched when no stake authority is passed', async () => {
    const result = await run(delegationBody, undefined)
    expect(result.signingPaths).not.toContain(OUR_STAKE_PATH)
  })

  it('still resolves the payment side alongside it', async () => {
    // The two are independent: the delegation needs the stake quorum, the inputs
    // need the payment quorum, and a transaction owes both.
    const result = await run(delegationBody, STAKE_AUTHORITY)
    expect(result.signingPaths).toContain("m/1854'/1815'/0'/0/0")
  })
})
