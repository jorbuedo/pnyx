/**
 * Shared, pure review helpers used by both IR producers (the CBOR/signing path
 * in `cardano.ts` and the indexed/history path in `history.ts`): ownership
 * classification, per-party aggregation, and net splitting. No decode, no I/O.
 *
 * @module
 */

import type {
  AddressGroup,
  AddressRef,
  OwnerKind,
  Ownership,
  PartyAggregate,
  ReviewedAmount,
  ReviewedDelta,
  ReviewedIO,
  WalletContext,
} from './types.js'
import {addAmount, addValue, COIN, emptyValue, toAmounts, type ValueMap} from './value.js'

export const addressRef = (view: {readonly hex: string; readonly bech32?: string}): AddressRef => ({
  hex: view.hex,
  ...(view.bech32 !== undefined ? {bech32: view.bech32} : {}),
})

/** The owner whose stake credential matches, if any. Wallet wins over identity. */
const stakeOwner = (context: WalletContext, stakeHashHex: string): OwnerKind | undefined => {
  if (context.stakeKeyHashHex === stakeHashHex) return 'wallet'
  if (context.identity?.stakeKeyHashHex === stakeHashHex) return 'identity'
  return undefined
}

/** The owner whose payment key matches, if any. Wallet wins over identity. */
const paymentOwner = (context: WalletContext, paymentHashHex: string): OwnerKind | undefined => {
  if (context.paymentKeyHashes.has(paymentHashHex)) return 'wallet'
  if (context.identity?.paymentKeyHashes.has(paymentHashHex) === true) return 'identity'
  return undefined
}

/**
 * The owner of a lone key hash — a vkey witness, which carries no hint as to
 * whether it is a payment or a stake key. Both are checked: a withdrawal or a
 * stake certificate is satisfied by the stake key's own witness.
 */
export const keyHashOwner = (context: WalletContext, keyHashHex: string): OwnerKind | undefined =>
  paymentOwner(context, keyHashHex) ?? stakeOwner(context, keyHashHex)

/**
 * Ownership of a (payment, stake) credential pair against the wallet context.
 *
 * The payment credential decides first, because it decides who can spend. Only
 * when it isn't ours does the stake credential matter, and then *what* the
 * payment credential is separates the two cases that used to collapse together:
 * a script means our escrow, a foreign key means our stake credential is being
 * reused under someone else's spending key.
 *
 * A script credential is ours only when the context names it — a native-script
 * wallet spending through its own policy. Every other script stays an escrow at
 * best, so widening this does not weaken the distinction it draws.
 */
export const classifyCreds = (
  context: WalletContext,
  payment: {readonly hashHex: string; readonly isScript: boolean} | undefined,
  stake: {readonly hashHex: string; readonly isScript: boolean} | undefined,
): Ownership => {
  if (payment !== undefined && !payment.isScript) {
    const owner = paymentOwner(context, payment.hashHex)
    if (owner !== undefined) return {level: 'own', owner}
  }
  if (payment?.isScript === true && context.paymentScriptHashes?.has(payment.hashHex) === true) {
    return {level: 'own', owner: 'wallet'}
  }
  // A shared script is ours only *with* our stake credential. Checked before the escrow branch
  // below, which would otherwise catch it — a CIP-113 smart wallet has exactly the shape of an
  // escrow (a script over our stake key) and differs only in that we know how to spend it.
  if (
    payment?.isScript === true &&
    context.sharedPaymentScriptHashes?.has(payment.hashHex) === true &&
    stake !== undefined &&
    stakeOwner(context, stake.hashHex) !== undefined
  ) {
    return {level: 'own', owner: 'wallet'}
  }
  if (stake !== undefined && !stake.isScript) {
    const owner = stakeOwner(context, stake.hashHex)
    // Without a payment credential we cannot tell an escrow from a hijack. The
    // only such shape is a reward address, which never appears as an input or
    // output address — if that ever changes, this needs a deliberate answer
    // rather than a default.
    if (owner !== undefined && payment !== undefined) {
      return payment.isScript ? {level: 'escrow', owner} : {level: 'stake-hijack', owner}
    }
  }
  return {level: 'none'}
}

/** True when we hold the payment credential, i.e. we can spend it. */
export const isSpendable = (ownership: Ownership): boolean => ownership.level === 'own'

/** The stake credential of an IO we can spend, when it is a key and is not ours. */
const externalStakeOf = (context: WalletContext, io: ReviewedIO): string | undefined => {
  if (io.ownership.level !== 'own' || io.ownership.owner !== 'wallet') return undefined
  const stake = io.credentials?.stake
  if (stake === undefined || stake.type === 'script') return undefined
  return stake.hashHex === context.stakeKeyHashHex ? undefined : stake.hashHex
}

/**
 * Whether this transaction spends coins parked under a stake credential that is not ours and
 * leaves nothing behind under it.
 *
 * The multi-delegation shape: our payment key, someone else's stake key, so we can spend it but
 * its delegation is not ours to control. Because every builder sends change to the primary
 * address, spending such a UTxO quietly re-homes those coins under this wallet's own stake key and
 * ends the delegation the user chose. An output back at the *same* stake credential means the
 * arrangement survives, so only its absence is worth saying.
 */
export const endsExternalDelegation = (
  context: WalletContext,
  inputs: readonly ReviewedIO[],
  outputs: readonly ReviewedIO[],
): boolean => {
  const returned = new Set(outputs.flatMap((io) => [externalStakeOf(context, io) ?? []].flat()))
  return inputs.some((io) => {
    const stake = externalStakeOf(context, io)
    return stake !== undefined && !returned.has(stake)
  })
}

export const ioValue = (io: ReviewedIO): ValueMap => {
  const value = emptyValue()
  for (const amount of io.amounts) addAmount(value, amount.assetId ?? COIN, amount.quantity)
  return value
}

/** Split a netted value into positive (received) and negative→positive (sent) amount lists. */
export const splitNet = (net: ValueMap): {sent: readonly ReviewedAmount[]; received: readonly ReviewedAmount[]} => {
  const received = emptyValue()
  const sent = emptyValue()
  for (const [assetId, quantity] of net) {
    if (quantity > 0n) addAmount(received, assetId, quantity)
    else if (quantity < 0n) addAmount(sent, assetId, -quantity)
  }
  return {sent: toAmounts(sent), received: toAmounts(received)}
}

/** The tier an ownership sorts into. Hijack addresses are counterparties. */
const tierOf = (ownership: Ownership): 'own' | 'identity' | 'escrow' | 'other' => {
  if (ownership.level === 'own') return ownership.owner === 'wallet' ? 'own' : 'identity'
  if (ownership.level === 'escrow') return 'escrow'
  return 'other'
}

type Bucket = {
  readonly key: string
  readonly ownership: Ownership
  readonly addresses: AddressRef[]
  readonly seen: Set<string>
  readonly stakeCredHex?: string
  readonly net: ValueMap
}

/** Signed contribution of an IO: outputs add, inputs subtract. */
const contributions = (
  inputs: readonly ReviewedIO[],
  outputs: readonly ReviewedIO[],
): readonly {readonly io: ReviewedIO; readonly sign: 1n | -1n}[] => [
  ...inputs.map((io) => ({io, sign: -1n as const})),
  ...outputs.map((io) => ({io, sign: 1n as const})),
]

const asDeltas = (net: ValueMap): readonly ReviewedDelta[] =>
  [...net.entries()].map(([assetId, delta]) => (assetId === COIN ? {delta} : {assetId, delta}))

/**
 * Group a tier's IOs into parties.
 *
 * Our own tiers aggregate **per stake credential**: every address under one
 * stake key is one position, which is what a reader thinks of as "my wallet"
 * even across change addresses and account indexes. External tiers stay one
 * party per address, since two unrelated addresses are two counterparties.
 *
 * When the producer could not inspect credentials (the history path), our own
 * addresses fall into a single unkeyed party — the previous behaviour.
 */
const partiesOf = (
  tierContributions: readonly {readonly io: ReviewedIO; readonly sign: 1n | -1n}[],
  groupBy: 'stake' | 'address',
): readonly PartyAggregate[] => {
  const buckets = new Map<string, Bucket>()
  const order: string[] = []

  for (const {io, sign} of tierContributions) {
    const stakeCredHex = io.credentials?.stake?.hashHex
    const key = groupBy === 'stake' ? `stake:${stakeCredHex ?? ''}` : `addr:${io.address.hex}`
    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = {
        key,
        ownership: io.ownership,
        addresses: [],
        seen: new Set(),
        ...(stakeCredHex !== undefined ? {stakeCredHex} : {}),
        net: emptyValue(),
      }
      buckets.set(key, bucket)
      order.push(key)
    }
    if (!bucket.seen.has(io.address.hex)) {
      bucket.seen.add(io.address.hex)
      bucket.addresses.push(io.address)
    }
    addValue(bucket.net, ioValue(io), sign)
  }

  return order.map((key) => {
    const bucket = buckets.get(key) as Bucket
    const split = splitNet(bucket.net)
    return {
      ownership: bucket.ownership,
      addresses: bucket.addresses,
      ...(bucket.stakeCredHex !== undefined ? {stakeCredHex: bucket.stakeCredHex} : {}),
      sent: split.sent,
      received: split.received,
    }
  })
}

/**
 * Partition the transaction's addresses into the four ownership tiers, each with
 * per-party netted sent/received.
 *
 * The identity is kept out of `ownGroup` on purpose: it is the user's, but a
 * different seed, so folding it in would report its receipts as this wallet's
 * balance change (`ownDelta` follows the same rule).
 */
export const buildGroups = (
  inputs: readonly ReviewedIO[],
  outputs: readonly ReviewedIO[],
): {
  ownGroup: AddressGroup
  identityGroup: AddressGroup
  escrowGroup: AddressGroup
  otherGroup: AddressGroup
} => {
  const all = contributions(inputs, outputs)
  const build = (tier: 'own' | 'identity' | 'escrow' | 'other'): AddressGroup => {
    const tierContributions = all.filter(({io}) => tierOf(io.ownership) === tier)
    const net = emptyValue()
    for (const {io, sign} of tierContributions) addValue(net, ioValue(io), sign)
    return {
      entries: tierContributions.map(({io}) => io),
      deltas: asDeltas(net),
      // Escrows are ours but each script address is its own position, so they
      // group per address like counterparties do.
      parties: partiesOf(tierContributions, tier === 'own' || tier === 'identity' ? 'stake' : 'address'),
    }
  }

  return {
    ownGroup: build('own'),
    identityGroup: build('identity'),
    escrowGroup: build('escrow'),
    otherGroup: build('other'),
  }
}

/** Counterparties convenience: external parties that net-receive something. */
export const counterpartiesOf = (
  otherGroup: AddressGroup,
): readonly {readonly address: AddressRef; readonly received: readonly ReviewedAmount[]}[] =>
  otherGroup.parties
    .filter((p) => p.received.length > 0 && p.addresses[0] !== undefined)
    .map((p) => ({address: p.addresses[0] as AddressRef, received: p.received}))

/** Own net delta (own outputs − own inputs) as a mutable value map. */
export const ownDeltaValue = (inputs: readonly ReviewedIO[], outputs: readonly ReviewedIO[]): ValueMap => {
  const delta = emptyValue()
  // The signing wallet's spendable delta — see buildGroups on why the identity
  // is excluded here.
  const isOwn = (o: Ownership) => o.level === 'own' && o.owner === 'wallet'
  for (const io of outputs) if (isOwn(io.ownership)) addValue(delta, ioValue(io))
  for (const io of inputs) if (isOwn(io.ownership)) addValue(delta, ioValue(io), -1n)
  return delta
}
