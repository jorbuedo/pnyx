import {Assets as EvAssets, TransactionWitnessSet} from '@evolution-sdk/evolution'
import {Plan} from '@evolution-sdk/plan'
import {AddressHex, type KeyHashHex, TxHashHex, XpubHex} from '@evolution-sdk/review/Brands'
import {layer as EvolutionDecodeLayer} from '@evolution-sdk/review/Decode'
import {Address, Certs} from '@pnyx/cardano-core'
import type {SigningSuccess} from '@pnyx/signing-service'
import {Effect} from 'effect'
import {beforeAll, describe, expect, it, vi} from 'vitest'
import {KEY_AUTHORITY, type SpendAuthority} from '../../services/cardano/account'
import type {EnvelopeSigner} from '../../services/cardano/cosign/types'
import {cardanoAccountFromSharedWallet} from '../../services/cardano/multisig/account'
import {paymentKeyHashAt} from '../../services/cardano/multisig/derive'
import {flatTemplate, tagAt} from '../../services/cardano/multisig/template'
import type {SharedWallet} from '../../services/cardano/multisig/types'
import type {CardanoRail} from '../../services/cardano/rail'
import {buildGatherContext, envelopeFromSignature, type GatherContext, withGather} from './multisig-gather'
import type {ReviewTicket} from './review-handoff'

const authority: Extract<SpendAuthority, {kind: 'script'}> = {
  kind: 'script',
  indexes: [
    {
      keyIndex: 3,
      scriptHashHex: 'cc'.repeat(28),
      nativeScriptHex: '8201',
      signerKeyHashes: ['aa'.repeat(28), 'bb'.repeat(28)],
      requiredSigners: 2,
    },
  ],
  stake: {
    scriptHashHex: 'dd'.repeat(28),
    nativeScriptHex: '8202',
    signerKeyHashes: ['11'.repeat(28), '22'.repeat(28)],
    requiredSigners: 2,
  },
  validity: {invalidBefore: null, invalidHereafter: null},
  signingGroupId: 'group-home',
}

const signers: readonly EnvelopeSigner[] = [
  {id: 'cosigner#0', name: 'Alice', keyHashHex: 'aa'.repeat(28), signed: false, isSelf: true},
  {id: 'cosigner#1', name: 'Bob', keyHashHex: 'bb'.repeat(28), signed: false},
]

let ctx: GatherContext
let emptyWitnessSet = ''

beforeAll(async () => {
  // A structurally valid witness set signed by nobody yet.
  emptyWitnessSet = TransactionWitnessSet.toCBORHex(TransactionWitnessSet.fromEncoded({}))
  ctx = {
    authority,
    chainId: 'cardano:preprod',
    groupId: 'shared-1',
    createdBy: 'Treasury',
    accountIndex: 0,
    keyIndexes: [3],
    nativeScriptHexes: ['8201'],
    scriptRoles: ['payment'],
    signers,
    createdAt: '2026-08-09T00:00:00.000Z',
    bodyHex: 'a1b2c3',
  }
})

const baseTicket = (over: Partial<ReviewTicket> = {}): ReviewTicket =>
  ({
    legs: [],
    groupId: 'shared-1',
    titleKey: 'x',
    onSettled: vi.fn(),
    onError: vi.fn(),
    onCancel: vi.fn(),
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: partial ticket for the wrapper under test
  }) as any

const signedOnly = (witnessSetHex: string): SigningSuccess => ({_tag: 'TxSignedOnly', witnessSetHex}) as SigningSuccess

/** Three co-signers with xpubs CKDpub can actually derive from, 2-of-3. */
const TAGS = [tagAt(0), tagAt(1), tagAt(2)] as const
const sharedWallet = (): SharedWallet => {
  const template = flatTemplate({kind: 'atLeast', n: 2}, [...TAGS])
  return {
    id: 'shared-1',
    name: 'Treasury',
    coSigners: TAGS.map((tag, i) => ({
      tag,
      name: `C${i}`,
      accountXpubHex: XpubHex((i + 1).toString(16).repeat(2).repeat(64).slice(0, 128)),
      ...(i === 0 ? {isSelf: true as const} : {}),
    })),
    paymentTemplate: template,
    delegationTemplate: template,
    network: Address.Network.Testnet,
    accountIndex: 0,
    selfGroupId: 'group-home',
    createdAt: '2026-08-09T00:00:00.000Z',
  }
}

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

/**
 * A real transaction body, because the gather now reads one: whether the
 * delegation script belongs in the envelope is a property of the transaction,
 * and a stub body cannot answer it.
 */
const bodyFor = async (addressHex: string, over: Partial<Plan.UnsignedCardanoPlan> = {}): Promise<string> => {
  return Plan.buildUnsigned({
    inputs: [],
    mandatoryInputs: [{txHash: TxHashHex('aa'.repeat(32)), index: 0, assets: EvAssets.fromLovelace(20_000_000n)}],
    outputs: [],
    changeAddressHex: AddressHex(addressHex),
    params: PARAMS,
    signerCount: 4,
    ...over,
  }).bodyHex
}

/** A delegation of `stakeScriptHashHex` — the shape that pulls the stake script in. */
const delegationBodyFor = async (addressHex: string, stakeScriptHashHex: string): Promise<string> => {
  return bodyFor(addressHex, {
    certificates: [Effect.runSync(Certs.stakeDelegation(stakeScriptHashHex, 'f0'.repeat(28), true))],
  })
}

const runGather = (params: Parameters<typeof buildGatherContext>[0]) =>
  Effect.runPromise(buildGatherContext(params).pipe(Effect.provide(EvolutionDecodeLayer)))

const railFor = async (
  wallet: SharedWallet,
  keyIndex: number,
  otherIndexes: readonly number[] = [],
): Promise<Pick<CardanoRail, 'account' | 'config'>> => {
  const account = await Effect.runPromise(
    cardanoAccountFromSharedWallet(wallet, keyIndex, otherIndexes) as Effect.Effect<CardanoRail['account']>,
  )
  return {
    account,
    config: {network: 'preprod'} as CardanoRail['config'],
  }
}

describe('buildGatherContext', () => {
  it('is null for a key wallet, so a producer wires it in without branching', async () => {
    const rail = {
      account: {authority: KEY_AUTHORITY} as CardanoRail['account'],
      config: {network: 'preprod'} as CardanoRail['config'],
    }
    const built = await runGather({rail, shared: null, bodyHex: 'a1', createdAt: '2026-08-09T00:00:00.000Z'})
    expect(built).toBeNull()
  })

  it('files the envelope under the shared wallet and names its whole roster', async () => {
    const wallet = sharedWallet()
    const rail = await railFor(wallet, 0)
    const built = await runGather({
      rail,
      shared: {wallet, keyIndex: 0},
      bodyHex: await bodyFor(rail.account.addressHex),
      createdAt: 'now',
    })
    expect(built?.groupId).toBe('shared-1')
    expect(built?.createdBy).toBe('Treasury')
    expect(built?.signers.map((s) => s.id)).toEqual([...TAGS])
    expect(built?.signers.filter((s) => s.isSelf === true)).toHaveLength(1)
  })

  it('binds each signer to the key hash at the spending index, not by roster position', async () => {
    // The envelope decides who has signed by matching a witness's key hash to a
    // signer row. Taking those hashes positionally off the authority would name
    // the wrong co-signer the moment a roster is reordered.
    const wallet = sharedWallet()
    const rail = await railFor(wallet, 4)
    const built = await runGather({
      rail,
      shared: {wallet, keyIndex: 4},
      bodyHex: await bodyFor(rail.account.addressHex),
      createdAt: 'now',
    })
    const expected = await Promise.all(
      wallet.coSigners.map((c) =>
        Effect.runPromise(paymentKeyHashAt(c.accountXpubHex, 4) as Effect.Effect<KeyHashHex>),
      ),
    )
    expect(built?.signers.map((s) => s.keyHashHex)).toEqual(expected)
  })

  it('carries the network-specific chain id, so the envelope assembles for preprod', async () => {
    const wallet = sharedWallet()
    const rail = await railFor(wallet, 0)
    const built = await runGather({
      rail,
      shared: {wallet, keyIndex: 0},
      bodyHex: await bodyFor(rail.account.addressHex),
      createdAt: 'now',
    })
    expect(built?.chainId).toBe('cardano:preprod')
  })

  describe('a spend across several payment indexes', () => {
    const twoIndexes = async () => {
      const wallet = sharedWallet()
      const rail = await railFor(wallet, 0, [3])
      const built = await runGather({
        rail,
        shared: {wallet, keyIndex: 0},
        bodyHex: await bodyFor(rail.account.addressHex),
        createdAt: 'now',
      })
      return {wallet, built}
    }

    it('names every index the authority covers, spending index first', async () => {
      const {built} = await twoIndexes()
      expect(built?.keyIndexes).toEqual([0, 3])
    })

    it('asks each co-signer once per index, because their key differs at each', async () => {
      const {built} = await twoIndexes()
      // Three co-signers over two indexes is six signatures owed, not three.
      expect(built?.signers).toHaveLength(6)
      expect(built?.signers.map((s) => s.scriptIndex ?? 0)).toEqual([0, 0, 0, 1, 1, 1])
    })

    it('derives every row key hash at its own index', async () => {
      // The witness→row match is by key hash. Reusing index 0's hashes for index
      // 3's rows would credit a signature to a row the ledger never asked for,
      // and leave the real one uncounted.
      const {wallet, built} = await twoIndexes()
      const expected = await Promise.all(
        [0, 3].flatMap((index) =>
          wallet.coSigners.map((c) =>
            Effect.runPromise(paymentKeyHashAt(c.accountXpubHex, index) as Effect.Effect<KeyHashHex>),
          ),
        ),
      )
      expect(built?.signers.map((s) => s.keyHashHex)).toEqual(expected)
      // And no hash is shared between the two indexes.
      expect(new Set(expected).size).toBe(6)
    })

    it('marks our own row at every index, so each is offered for signing', async () => {
      const {built} = await twoIndexes()
      expect(built?.signers.filter((s) => s.isSelf === true)).toHaveLength(2)
    })
  })
})

describe('withGather', () => {
  it('returns a key wallet’s ticket untouched, by identity', () => {
    const ticket = baseTicket()
    expect(withGather(ticket, null, vi.fn())).toBe(ticket)
  })

  it('attaches a quorum panel so the user sees what they are confirming', () => {
    // Not "this will be submitted" but "this needs 2 signatures and yours is one".
    const wrapped = withGather(baseTicket(), ctx, vi.fn())
    expect(wrapped.signatureStatus).toMatchObject({required: 2, total: 2, signed: 0, meetsQuorum: false})
  })

  it('does not override a panel the producer already supplied', () => {
    const supplied = {kind: 'multisig', required: 3, total: 5, signed: 1, meetsQuorum: false, signers} as const
    expect(withGather(baseTicket({signatureStatus: supplied}), ctx, vi.fn()).signatureStatus).toBe(supplied)
  })
})

describe('withGather — settling', () => {
  it('routes to the co-sign rail with a stable id', async () => {
    const navigate = vi.fn()
    withGather(baseTicket(), ctx, navigate).onSettled([signedOnly(emptyWitnessSet)])
    await vi.waitFor(() => expect(navigate).toHaveBeenCalledTimes(1))
    expect(navigate.mock.calls[0]?.[0]).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is idempotent on the body — the same transaction files under the same id', async () => {
    const a = vi.fn()
    const b = vi.fn()
    withGather(baseTicket(), ctx, a).onSettled([signedOnly(emptyWitnessSet)])
    withGather(baseTicket(), ctx, b).onSettled([signedOnly(emptyWitnessSet)])
    await vi.waitFor(() => expect(a).toHaveBeenCalled())
    await vi.waitFor(() => expect(b).toHaveBeenCalled())
    expect(a.mock.calls[0]?.[0]).toBe(b.mock.calls[0]?.[0])
  })

  it('falls back to the producer when the result is not a sign-only pass', () => {
    // Every script request is forced sign-only, so this means the rewrite did
    // not run — handing it back is more honest than inventing an envelope.
    const onSettled = vi.fn()
    const navigate = vi.fn()
    const results = [{_tag: 'TxBroadcast', txId: 'deadbeef'} as unknown as SigningSuccess]
    withGather(baseTicket({onSettled}), ctx, navigate).onSettled(results)
    expect(onSettled).toHaveBeenCalledWith(results)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('falls back when a ceremony returns several legs', () => {
    const onSettled = vi.fn()
    const results = [signedOnly(emptyWitnessSet), signedOnly(emptyWitnessSet)]
    withGather(baseTicket({onSettled}), ctx, vi.fn()).onSettled(results)
    expect(onSettled).toHaveBeenCalledWith(results)
  })
})

describe('buildGatherContext — a transaction that also delegates', () => {
  const delegating = async () => {
    const wallet = sharedWallet()
    const rail = await railFor(wallet, 0)
    if (rail.account.authority.kind !== 'script') throw new Error('expected a script authority')
    const stake = rail.account.authority.stake
    const built = await runGather({
      rail,
      shared: {wallet, keyIndex: 0},
      bodyHex: await delegationBodyFor(rail.account.addressHex, stake.scriptHashHex),
      createdAt: 'now',
    })
    return {wallet, rail, stake, built}
  }

  it('adds the delegation script, after the payment ones', async () => {
    // Payment first so a co-signer reading an older envelope finds the same
    // script at the same `scriptIndex` it always did.
    const {stake, built} = await delegating()
    expect(built?.nativeScriptHexes).toHaveLength(2)
    expect(built?.nativeScriptHexes[1]).toBe(stake.nativeScriptHex)
    expect(built?.scriptRoles).toEqual(['payment', 'stake'])
  })

  it('leaves it out of a plain spend from the same wallet', async () => {
    // The wallet has a delegation script either way; only a transaction that
    // names its stake credential may carry it, or the ledger rejects the lot.
    const wallet = sharedWallet()
    const rail = await railFor(wallet, 0)
    const built = await runGather({
      rail,
      shared: {wallet, keyIndex: 0},
      bodyHex: await bodyFor(rail.account.addressHex),
      createdAt: 'now',
    })
    expect(built?.nativeScriptHexes).toHaveLength(1)
    expect(built?.scriptRoles).toEqual(['payment'])
  })

  it('asks the roster for a stake signature on top of the payment one', async () => {
    const {built} = await delegating()
    // Three co-signers owe a payment witness each and a stake witness each.
    expect(built?.signers).toHaveLength(6)
    expect(built?.signers.slice(3).map((s) => s.scriptIndex)).toEqual([1, 1, 1])
  })

  it('binds the stake rows to stake key hashes, which differ from the payment ones', async () => {
    // Same co-signers, different keys: CIP-1854 derives stake at role 2. A row
    // carrying the payment hash would credit the delegation to a witness the
    // delegation script does not name.
    const {built} = await delegating()
    const payment = new Set(built?.signers.slice(0, 3).map((s) => s.keyHashHex))
    for (const row of built?.signers.slice(3) ?? []) expect(payment.has(row.keyHashHex)).toBe(false)
  })

  it('marks the stake entry with index 0, where CIP-1854 pins stake keys', async () => {
    const {built} = await delegating()
    expect(built?.keyIndexes).toEqual([0, 0])
  })

  it('writes both scripts into the envelope, with their roles', async () => {
    const {built, stake} = await delegating()
    if (!built) throw new Error('expected a gather context')
    const envelope = await Effect.runPromise(envelopeFromSignature(built, built.bodyHex, emptyWitnessSet))
    expect(envelope.nativeScriptHexes).toContain(stake.nativeScriptHex)
    expect(envelope.scriptRoles).toEqual(['payment', 'stake'])
  })

  it('leaves scriptRoles off an all-payment envelope, so older readers see no change', async () => {
    const wallet = sharedWallet()
    const rail = await railFor(wallet, 0)
    const built = await runGather({
      rail,
      shared: {wallet, keyIndex: 0},
      bodyHex: await bodyFor(rail.account.addressHex),
      createdAt: 'now',
    })
    if (!built) throw new Error('expected a gather context')
    const envelope = await Effect.runPromise(envelopeFromSignature(built, built.bodyHex, emptyWitnessSet))
    expect('scriptRoles' in envelope).toBe(false)
  })

  it('counts the delegation quorum in the panel the user confirms against', async () => {
    // 2-of-3 paying and 2-of-3 delegating is four signatures. A panel saying two
    // would have the user expecting a submit while the certificate is still
    // unauthorised.
    const {built} = await delegating()
    if (!built) throw new Error('expected a gather context')
    const ticket = withGather(baseTicket(), built, vi.fn())
    expect(ticket.signatureStatus?.required).toBe(4)
  })
})
