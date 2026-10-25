import type {ReviewedTransaction} from '@pnyx/tx-review'
import {describe, expect, it} from 'vitest'
import {activityType} from '../history-grouping'
import {type Cip113Marks, cip113ActionOf, isProgrammableTokenTx} from './activity'

const PLB = '33ceea92481cd6cc5b9ad1750302642042bb8ea5d028b830ad86fc31'
const OTHER_SCRIPT = 'ab'.repeat(28)
const REGISTRY_POLICY = 'ef'.repeat(28)

const marks = (over: Partial<Cip113Marks> = {}): Cip113Marks => ({
  scriptCredentials: new Set([PLB]),
  plbScriptHashHex: PLB,
  registryPolicyHex: REGISTRY_POLICY,
  ...over,
})

const io = (hashHex: string | null, type: 'key' | 'script' = 'script') => ({
  address: 'addr_test1...',
  ...(hashHex === null ? {} : {credentials: {payment: {hashHex, type}}}),
})

const tx = (inputs: unknown[], outputs: unknown[]): ReviewedTransaction =>
  ({
    hash: 'aa',
    inputs,
    outputs,
    operations: [],
    ownDelta: [],
  }) as unknown as ReviewedTransaction

describe('isProgrammableTokenTx', () => {
  it('recognises a spend from a smart wallet', () => {
    expect(isProgrammableTokenTx(tx([io(PLB)], [io(null)]), new Set([PLB]))).toBe(true)
  })

  it('recognises a payment into a smart wallet, which a mint is', () => {
    // The mint that created our test token pays the token to the smart wallet and spends only
    // ordinary inputs, so an inputs-only check would miss the transaction that matters most.
    expect(isProgrammableTokenTx(tx([io(null, 'key')], [io(PLB)]), new Set([PLB]))).toBe(true)
  })

  it('is case-insensitive about the credential', () => {
    expect(isProgrammableTokenTx(tx([io(PLB.toUpperCase())], []), new Set([PLB]))).toBe(true)
  })

  it('does not claim another script', () => {
    expect(isProgrammableTokenTx(tx([io(OTHER_SCRIPT)], []), new Set([PLB]))).toBe(false)
  })

  it('does not claim a key credential that happens to equal the hash', () => {
    // Credential hashes live in separate namespaces; a key hash colliding with a script hash is
    // not this contract, and matching on bytes alone would say it was.
    expect(isProgrammableTokenTx(tx([io(PLB, 'key')], []), new Set([PLB]))).toBe(false)
  })

  it('matches nothing when no deployment is shipped for the network', () => {
    // ⚠️ A null must match nothing. An empty-string default here would match every input whose
    // credential is absent, labelling unrelated transactions as programmable-token ones.
    expect(isProgrammableTokenTx(tx([io(PLB)], []), new Set<string>())).toBe(false)
  })

  it('tolerates an entry with no credentials at all', () => {
    expect(isProgrammableTokenTx(tx([io(null)], [io(null)]), new Set([PLB]))).toBe(false)
  })
})

describe('activityType with a CIP-113 deployment', () => {
  it('recognises a registry operation, not only a smart-wallet one', () => {
    // Four transactions made this token: a stake registration, a registry insert, an issuance and
    // a transfer. Only two touch a smart wallet, so matching the PLB alone left the registry insert
    // reading "Smart Contract" — a protocol half-recognised, which looks like a bug.
    const REGISTRY_SPEND = 'cd'.repeat(28)
    expect(activityType(tx([io(REGISTRY_SPEND)], []), marks({scriptCredentials: new Set([PLB, REGISTRY_SPEND])}))).toBe(
      'programmableToken',
    )
  })

  it('names the contract instead of falling back to Smart Contract', () => {
    // The whole point: a PLB spend IS a script spend, so without this it reads "Smart Contract",
    // which tells a holder nothing about what happened to their token. A spend with no mint is
    // specifically a transfer, so the generic label is not the answer here — that is progress, and
    // this assertion moved rather than the behaviour regressing.
    expect(activityType(tx([io(PLB)], []), marks())).toBe('programmableTransfer')
  })

  it('still reads as Smart Contract for an unrelated script', () => {
    expect(activityType(tx([io(OTHER_SCRIPT)], []), marks())).toBe('smartContract')
  })

  it('reads as Smart Contract when no deployment is shipped', () => {
    expect(activityType(tx([io(PLB)], []), marks({scriptCredentials: new Set()}))).toBe('smartContract')
  })
})

/**
 * The three operations that actually created the test token on preview, in the shapes chain
 * reported for them — not invented fixtures. Sources: `3de2af56` (registry insert),
 * `b8c8b526` (issuance), `4fa56037` (transfer).
 */
describe('cip113ActionOf, against the shapes preview produced', () => {
  const mint = (policyIdHex: string) => ({kind: 'minting' as const, policyIdHex, assets: [], burns: false})
  const withOps = (t: ReviewedTransaction, operations: unknown[]) =>
    ({...t, operations}) as unknown as ReviewedTransaction

  it('a mint under the registry policy is a registration', () => {
    // `3de2af56`: mints ONE unit of the registry policy whose asset name is the token's policy id.
    // The policy identifies it; quantity and asset name need no reading.
    const t = withOps(tx([io(null, 'key')], [io(null, 'key')]), [mint(REGISTRY_POLICY)])
    expect(cip113ActionOf(t, marks())).toBe('registry')
  })

  it('any other mint landing at a smart wallet is an issuance', () => {
    // `b8c8b526`: mints 1,000,000 TEST out of ordinary inputs, paying the smart wallet.
    const t = withOps(tx([io(null, 'key')], [io(PLB)]), [mint('16b37cfe'.padEnd(56, '0'))])
    expect(cip113ActionOf(t, marks())).toBe('issue')
  })

  it('a smart-wallet input with no mint is a transfer', () => {
    // `4fa56037`: no mints, two withdrawals, PLB on both sides.
    expect(cip113ActionOf(tx([io(PLB)], [io(PLB)]), marks())).toBe('transfer')
  })

  it('order matters: an issuance both mints and pays a smart wallet', () => {
    // Testing `transfer` before `issue` would misread every issuance, since both touch the PLB.
    const t = withOps(tx([io(PLB)], [io(PLB)]), [mint('16b37cfe'.padEnd(56, '0'))])
    expect(cip113ActionOf(t, marks())).toBe('issue')
  })

  it('names nothing it cannot establish', () => {
    // The protocol has operations this does not enumerate. `other` still reads as "Programmable
    // token", which beats "Smart Contract" without claiming to know which action it was.
    expect(cip113ActionOf(tx([io('cd'.repeat(28))], []), marks())).toBe('other')
  })
})
