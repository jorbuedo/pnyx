/**
 * History IR producer: build the same {@link ReviewedTransaction} from an
 * INDEXED tx record (structured backend data, no CBOR) rather than a live body.
 * The second producer alongside `reviewCardanoTx` — one IR, two producers, two
 * consumers (confirm review + activity detail).
 *
 * Pure (no services): our own addresses are recognised by membership, and any
 * finer tier (escrows, the identity, a foreign address reusing our stake key)
 * comes from the credential inspector the app injects — this package will not
 * take a codec dependency to decode bech32 itself. Operations are mapped from the
 * structured certificate/withdrawal/mint input. Detail-tab fields the
 * indexed data lacks (collateral CBOR, witness set, script-data hash, TTL) are
 * simply absent — the review tabs already hide empty sections. Governance
 * votes/proposals are NOT reconstructed from indexed data (they need the CBOR
 * body); that detail lives on the signing path.
 *
 * @module
 */

import type {Plan} from '@evolution-sdk/plan'
import {LARGE_FEE_LOVELACE} from './cardano.js'
import {buildGroups, classifyCreds, counterpartiesOf, ownDeltaValue} from './review-common.js'
import type {
  AddressRef,
  CardanoOperation,
  Outpoint,
  Ownership,
  ReviewedBlock,
  ReviewedCredential,
  ReviewedDRep,
  ReviewedIO,
  ReviewedOperation,
  ReviewedTransaction,
  TransactionWarning,
  WalletContext,
} from './types.js'
import {fromTokens, toAmounts} from './value.js'

/** A token amount on an indexed input/output. */
export type IndexedToken = {readonly policyIdHex: string; readonly assetNameHex: string; readonly amount: bigint}

/** An indexed input/output: a bech32 address + its value. */
export type IndexedIO = {
  readonly addressBech32: string
  readonly coin: bigint
  readonly tokens: readonly IndexedToken[]
  /** The UTxO's own identity — on an input, the transaction that created it. */
  readonly outpoint?: Outpoint
}

/** Structured certificate from indexed data (the common, history-relevant kinds). */
export type IndexedCertificate =
  | {
      readonly kind: 'stake-registration'
      readonly credentialHashHex: string
      readonly isScript?: boolean
      readonly deposit?: bigint
    }
  | {
      readonly kind: 'stake-deregistration'
      readonly credentialHashHex: string
      readonly isScript?: boolean
      readonly deposit?: bigint
    }
  | {
      readonly kind: 'stake-delegation'
      readonly credentialHashHex: string
      readonly isScript?: boolean
      readonly poolKeyHashHex: string
    }
  | {
      readonly kind: 'vote-delegation'
      readonly credentialHashHex: string
      readonly isScript?: boolean
      readonly drep: ReviewedDRep
    }
  | {readonly kind: 'pool-retirement'; readonly poolKeyHashHex: string; readonly epoch: bigint}
  | {readonly kind: 'unknown'; readonly label?: string}

/** A structured, backend-indexed transaction (Koios-shaped, chain-agnostic surface). */
export type IndexedCardanoTx = {
  readonly hash: string
  readonly slot?: number
  readonly blockHeight?: number
  readonly epochNo?: number
  readonly blockHashHex?: string
  /** ISO-8601 timestamp. */
  readonly time?: string
  readonly fee: bigint
  readonly inputs: readonly IndexedIO[]
  readonly outputs: readonly IndexedIO[]
  readonly certificates?: readonly IndexedCertificate[]
  readonly withdrawals?: readonly {readonly rewardAddressBech32: string; readonly amount: bigint}[]
  readonly mint?: readonly IndexedToken[]
  readonly metadata?: Record<string, unknown>
  /** Phase-2 validity (false = collateral was consumed). Absent → assumed valid. */
  readonly valid?: boolean
  readonly networkId?: number
}

/**
 * Wallet self-knowledge for the history path.
 *
 * Membership in `ownAddressesBech32` decides *our own* addresses and stays
 * authoritative for them: it covers every discovered address, whereas the
 * credential sets only carry the account's own key hashes.
 *
 * Everything past own/other needs the address's credentials — our escrows, the
 * identity, and a foreign address wearing our stake key are all credential
 * facts. Decoding bech32 needs a codec, which this package deliberately does not
 * depend on, so the app supplies `credentialsOf`. Without it the history path
 * degrades to own/other, which is what it did before.
 */
export type HistoryWalletContext = {
  readonly ownAddressesBech32: ReadonlySet<string>
  readonly rewardAddressBech32?: string
  /** The wallet's (and identity's) credentials, for tiering beyond own/other. */
  readonly wallet?: WalletContext
  /** Inspect an address's credentials — supplied by the app, which has a codec. */
  readonly credentialsOf?: (addressBech32: string) => ReviewedIO['credentials']
}

/**
 * An indexer record's block context in IR shape, or `undefined` when it reported
 * none of it — a transaction with no block facts carries no `block` object rather
 * than an object of four absences, and an unreported height never reads as zero.
 *
 * Shared by both indexed sources (this package's {@link IndexedCardanoTx} and the
 * provider's own row, which names these fields identically).
 */
export const reviewedBlockOf = (indexed: {
  readonly slot?: number
  readonly blockHeight?: number
  readonly epochNo?: number
  readonly blockHashHex?: string
}): ReviewedBlock | undefined => {
  const block: ReviewedBlock = {
    ...(indexed.slot !== undefined ? {slot: indexed.slot} : {}),
    ...(indexed.blockHeight !== undefined ? {height: indexed.blockHeight} : {}),
    ...(indexed.epochNo !== undefined ? {epoch: indexed.epochNo} : {}),
    ...(indexed.blockHashHex !== undefined ? {hashHex: indexed.blockHashHex} : {}),
  }
  return Object.keys(block).length === 0 ? undefined : block
}

/** `{hashHex, type}` → the `{hashHex, isScript}` shape `classifyCreds` takes. */
const asCredArg = (cred: ReviewedCredential | undefined) =>
  cred === undefined ? undefined : {hashHex: cred.hashHex, isScript: cred.type === 'script'}

const ioOf = (context: HistoryWalletContext, io: IndexedIO): ReviewedIO => {
  const address: AddressRef = {hex: io.addressBech32, bech32: io.addressBech32}
  const credentials = context.credentialsOf?.(io.addressBech32)
  const ownership: Ownership = context.ownAddressesBech32.has(io.addressBech32)
    ? {level: 'own', owner: 'wallet'}
    : context.wallet !== undefined && credentials !== undefined
      ? classifyCreds(context.wallet, asCredArg(credentials.payment), asCredArg(credentials.stake))
      : {level: 'none'}
  return {
    address,
    ownership,
    amounts: toAmounts(
      fromTokens(
        io.coin,
        io.tokens.map((t) => ({policyIdHex: t.policyIdHex, assetNameHex: t.assetNameHex, amount: t.amount})),
      ),
    ),
    ...(credentials !== undefined ? {credentials} : {}),
    ...(io.outpoint !== undefined ? {outpoint: io.outpoint} : {}),
  }
}

const mintOp = (mint: readonly IndexedToken[]): ReviewedOperation[] => {
  if (mint.length === 0) return []
  const byPolicy = new Map<string, {assetNameHex: string; quantity: bigint}[]>()
  for (const t of mint) {
    const list = byPolicy.get(t.policyIdHex) ?? []
    list.push({assetNameHex: t.assetNameHex, quantity: t.amount})
    byPolicy.set(t.policyIdHex, list)
  }
  return [...byPolicy.entries()].map(([policyIdHex, assets]) => ({
    kind: 'minting' as const,
    policyIdHex,
    assets,
    burns: assets.some((a) => a.quantity < 0n),
  }))
}

const certOp = (cert: IndexedCertificate, params: Plan.ProtocolParams): CardanoOperation | null => {
  const credOf = (hashHex: string, isScript?: boolean) => ({
    hashHex,
    type: (isScript ? 'script' : 'key') as 'key' | 'script',
  })
  switch (cert.kind) {
    case 'stake-registration':
      return {
        kind: 'stake-registration',
        credential: credOf(cert.credentialHashHex, cert.isScript),
        deposit: cert.deposit ?? params.keyDeposit,
      }
    case 'stake-deregistration':
      return {
        kind: 'stake-deregistration',
        credential: credOf(cert.credentialHashHex, cert.isScript),
        deposit: cert.deposit ?? params.keyDeposit,
      }
    case 'stake-delegation':
      return {
        kind: 'stake-delegation',
        credential: credOf(cert.credentialHashHex, cert.isScript),
        poolKeyHashHex: cert.poolKeyHashHex,
      }
    case 'vote-delegation':
      return {kind: 'vote-delegation', credential: credOf(cert.credentialHashHex, cert.isScript), drep: cert.drep}
    case 'pool-retirement':
      return {kind: 'pool-retirement', poolKeyHashHex: cert.poolKeyHashHex, epoch: cert.epoch}
    case 'unknown':
      // Dropping it silently is how a pool registration came to render as a bare
      // fee transfer. Surfacing it also raises the `unknown-certificate` warning.
      return {kind: 'unknown-certificate', ...(cert.label !== undefined ? {label: cert.label} : {})}
  }
}

/**
 * Build the review IR from an indexed transaction record. `params` sources cert
 * deposits when the indexed cert omits them; `status` defaults to `confirmed`
 * (indexed txs are on-chain) unless `valid === false` → `failed`.
 */
export const reviewCardanoFromHistory = (
  indexed: IndexedCardanoTx,
  context: HistoryWalletContext,
  params: Plan.ProtocolParams,
): ReviewedTransaction => {
  const inputs = indexed.inputs.map((io) => ioOf(context, io))
  const outputs = indexed.outputs.map((io) => ioOf(context, io))
  const {ownGroup, identityGroup, escrowGroup, otherGroup} = buildGroups(inputs, outputs)

  const operations: ReviewedOperation[] = []
  for (const cert of indexed.certificates ?? []) {
    const op = certOp(cert, params)
    if (op !== null) operations.push(op)
  }

  const ownDelta = ownDeltaValue(inputs, outputs)
  for (const w of indexed.withdrawals ?? []) {
    const own = context.rewardAddressBech32 !== undefined && w.rewardAddressBech32 === context.rewardAddressBech32
    operations.push({
      kind: 'reward-withdrawal',
      rewardAddress: {hex: w.rewardAddressBech32, bech32: w.rewardAddressBech32},
      amount: w.amount,
      own,
    })
  }
  operations.push(...mintOp(indexed.mint ?? []))

  const warnings = new Set<TransactionWarning>()
  if (indexed.fee > LARGE_FEE_LOVELACE) warnings.add('large-fee')
  for (const op of operations) if (op.kind === 'minting') warnings.add(op.burns ? 'burning' : 'minting')
  // Same rule as the signing path: an address wearing our stake credential under
  // a foreign payment key is worth surfacing wherever we render it.
  if ([...inputs, ...outputs].some((io) => io.ownership.level === 'stake-hijack')) {
    warnings.add('stake-credential-reuse')
  }

  const block = reviewedBlockOf(indexed)

  return {
    chain: 'cardano',
    hash: indexed.hash,
    ...(indexed.time !== undefined ? {timestamp: indexed.time} : {}),
    // Only claimed when the source reported the phase-2 verdict. An indexer
    // summary that omits it leaves this absent: asserting `confirmed` there would
    // render a script-failed transaction — which is on-chain too — as a success.
    ...(indexed.valid !== undefined ? {status: indexed.valid ? ('confirmed' as const) : ('failed' as const)} : {}),
    ...(block !== undefined ? {block} : {}),
    ...(indexed.networkId !== undefined ? {networkId: indexed.networkId} : {}),
    fee: indexed.fee,
    inputs,
    unresolvedInputs: [],
    outputs,
    referenceInputs: [],
    metadata: indexed.metadata ?? {},
    requiredSigners: [],
    scripts: {native: 0, plutusV1: 0, plutusV2: 0, plutusV3: 0, redeemers: 0, datums: 0},
    ownDelta: toAmounts(ownDelta),
    ownGroup,
    identityGroup,
    escrowGroup,
    otherGroup,
    counterparties: counterpartiesOf(otherGroup),
    operations,
    warnings: [...warnings],
  } satisfies ReviewedTransaction
}

/**
 * True when withdrawing rewards is the transaction's **whole story**.
 *
 * Wallets sweep pending rewards into ordinary transactions, so "contains a
 * withdrawal" is close to meaningless as a label — on a real staking wallet it
 * matches a plurality of transactions, and labelling an outright send "Rewards"
 * hides what the transaction actually did. A withdrawal earns the label only
 * when nothing else happened: no other operation, and no value reaching any
 * party other than this wallet.
 */
export const isPureRewardWithdrawal = (reviewed: ReviewedTransaction): boolean => {
  const kinds = new Set(reviewed.operations.map((op) => op.kind))
  if (!kinds.has('reward-withdrawal')) return false
  // A certificate, mint or contract call makes the withdrawal a side-effect.
  for (const kind of kinds) if (kind !== 'reward-withdrawal') return false
  // Rewards landing in our own addresses is still just a withdrawal; value
  // reaching anyone else — including our own identity — is a transfer.
  return ![reviewed.identityGroup, reviewed.escrowGroup, reviewed.otherGroup].some((group) =>
    group.parties.some((party) => party.received.length > 0),
  )
}

/** Direction of a history item from the wallet's perspective (for list rows). */
export const historyDirection = (reviewed: ReviewedTransaction): 'sent' | 'received' | 'self' => {
  const coin = reviewed.ownDelta.find((a) => a.assetId === undefined)?.quantity ?? 0n
  const sentTokens = reviewed.ownDelta.some((a) => a.assetId !== undefined && a.quantity < 0n)
  const recvTokens = reviewed.ownDelta.some((a) => a.assetId !== undefined && a.quantity > 0n)
  if (coin < 0n || (coin === 0n && sentTokens && !recvTokens)) return 'sent'
  if (coin > 0n || recvTokens) return 'received'
  return 'self'
}
