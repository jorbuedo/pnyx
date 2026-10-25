import {Assets as EvAssets} from '@evolution-sdk/evolution'
import {Plan} from '@evolution-sdk/plan'
import {AddressHex, TxHashHex} from '@evolution-sdk/review/Brands'
import {Certs} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it} from 'vitest'
import type {TxEnvelope} from '../cosign/types'
import {findPendingStakeChange} from './pending-stake'

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

const OUR_STAKE_SCRIPT = 'de'.repeat(28)
const THEIR_STAKE_SCRIPT = 'fa'.repeat(28)
const ADDRESS = `30${'cc'.repeat(28)}${OUR_STAKE_SCRIPT}`

let delegationBody: string
let spendBody: string

const build = (over: Partial<Plan.UnsignedCardanoPlan> = {}): string =>
  Plan.buildUnsigned({
    inputs: [],
    mandatoryInputs: [{txHash: TxHashHex('aa'.repeat(32)), index: 0, assets: EvAssets.fromLovelace(20_000_000n)}],
    outputs: [],
    changeAddressHex: AddressHex(ADDRESS),
    params: PARAMS,
    signerCount: 2,
    ...over,
  }).bodyHex

beforeAll(async () => {
  delegationBody = build({
    certificates: [Effect.runSync(Certs.stakeDelegation(OUR_STAKE_SCRIPT, 'f0'.repeat(28), true))],
  })
  spendBody = build({outputs: [{addressHex: AddressHex(ADDRESS), assets: EvAssets.fromLovelace(5_000_000n)}]})
})

const entry = (id: string, bodyHex: string): {id: string; envelope: TxEnvelope} => ({
  id,
  envelope: {version: 1, bodyHex, nativeScriptHexes: [], signers: [], witnesses: []} as unknown as TxEnvelope,
})

const run = (entries: readonly {id: string; envelope: TxEnvelope}[], hash = OUR_STAKE_SCRIPT) =>
  Effect.runPromise(findPendingStakeChange(entries, hash))

describe('findPendingStakeChange', () => {
  it('finds a delegation waiting for signatures', async () => {
    // The case the stake screen could not see: the chain still reads the old
    // state, so it would build a second certificate for the same decision.
    expect(await run([entry('pending-1', delegationBody)])).toBe('pending-1')
  })

  it('does not block on a plain send from the same wallet', async () => {
    // A pending spend is not a staking change. Blocking on one would stop a user
    // delegating because they happen to have a transfer mid-gather.
    expect(await run([entry('pending-1', spendBody)])).toBeNull()
  })

  it('ignores a delegation of somebody else stake credential', async () => {
    expect(await run([entry('pending-1', delegationBody)], THEIR_STAKE_SCRIPT)).toBeNull()
  })

  it('skips a body it cannot decode rather than calling it a match', async () => {
    // "Cannot tell" is not "yes": refusing to build on an unreadable record would
    // strand the screen with no way forward and nothing to explain it.
    expect(await run([entry('junk', 'zzzz'), entry('real', delegationBody)])).toBe('real')
  })

  it('answers null for a wallet with nothing pending', async () => {
    expect(await run([])).toBeNull()
  })
})
