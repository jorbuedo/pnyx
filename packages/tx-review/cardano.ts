/**
 * Cardano review producer: tx body (+ optional witness set) + wallet context +
 * resolved inputs + protocol params → the wallet-aware {@link ReviewedTransaction}.
 *
 * Composes `Inspect.txBody` (full body view) with the `Analyze` decoders
 * (certificates / mint / voting / proposals / script summary) into the
 * fully-extracted operation union. Deposits are resolved from the certificate's
 * own field when present, else the matching protocol param — never fabricated.
 *
 * @module
 */

import {Plan} from '@evolution-sdk/plan'
import * as Analyze from '@evolution-sdk/review/Analyze'
import type {KeyHashHex, PublicKeyHex} from '@evolution-sdk/review/Brands'
import type {Decode} from '@evolution-sdk/review/Decode'
import type {CborError} from '@evolution-sdk/review/Errors'
import * as Inspect from '@evolution-sdk/review/Inspect'
import {Keys} from '@pnyx/cardano-core'
import * as Address from '@pnyx/cardano-core/Address'
import {Effect} from 'effect'
import {
  addressRef,
  buildGroups,
  classifyCreds,
  counterpartiesOf,
  endsExternalDelegation,
  keyHashOwner,
  ownDeltaValue,
} from './review-common.js'
import type {
  CardanoOperation,
  InputRef,
  ResolvedInput,
  ReviewedCredential,
  ReviewedDRep,
  ReviewedGovAction,
  ReviewedGovActionId,
  ReviewedIO,
  ReviewedOperation,
  ReviewedProposal,
  ReviewedTransaction,
  ReviewedVkeyWitness,
  ReviewedVote,
  ReviewedVoter,
  ScriptSummary,
  TransactionWarning,
  WalletContext,
} from './types.js'
import {fromTokens, toAmounts} from './value.js'

/** Fees above this are flagged `large-fee` (5 ADA). */
export const LARGE_FEE_LOVELACE = 5_000_000n

/**
 * A fee worth this share of what the transaction sends is flagged even when it is
 * under {@link LARGE_FEE_LOVELACE} — the flat cap cannot see the sub-5-ADA band,
 * which is where a tuned attack sits. Only checkable when the caller supplies a
 * {@link Plan.FeeBreakdown}; a dApp-supplied transaction has none.
 *
 * **Gated on the fee exceeding the protocol's own `linear` fee**
 * (`minFeeA * size + minFeeB`), because otherwise the ratio fires on every small
 * send. A Cardano fee has a fixed floor and is computed from *size*, not from the
 * amount sent — so a minimal 0.17 ADA fee is 11% of a 1.5 ADA send and trips a
 * 10% threshold while being the cheapest the chain will accept. Calling that
 * "unusually large" is false, and a warning that fires on ordinary sends trains
 * the reader to ignore the ones that matter.
 *
 * Comparing against `linear` rather than an absolute floor keeps the check
 * parameter-independent, which is the property the ratio was chosen for.
 */
export const LARGE_FEE_PERCENT_OF_SENT = 10

const hx = (b: Uint8Array): string => {
  let out = ''
  for (const byte of b) out += byte.toString(16).padStart(2, '0')
  return out
}
const inputKey = (txHashHex: string, index: number): string => `${txHashHex.toLowerCase()}#${index}`

/**
 * blake2b-224 of a vkey, or `undefined` when the bytes are not a key. A witness
 * set can carry anything; a malformed entry must not sink the whole review.
 */
const tryKeyHash = (vkeyHex: PublicKeyHex): KeyHashHex | undefined => {
  try {
    return Keys.keyHashSync(vkeyHex)
  } catch {
    return undefined
  }
}

/** Omit an optional field when its value is undefined (exactOptionalPropertyTypes-safe). */
const opt = <K extends string, V>(k: K, v: V | undefined): {[P in K]?: V} =>
  v === undefined ? {} : ({[k]: v} as {[P in K]: V})

// ── decode-type → IR-type helpers ──
const credOf = (c: {hash: Uint8Array; isScript: boolean}): ReviewedCredential => ({
  hashHex: hx(c.hash),
  type: c.isScript ? 'script' : 'key',
})

type DecodedDRep =
  | {readonly kind: 'key'; readonly hash: Uint8Array}
  | {readonly kind: 'script'; readonly hash: Uint8Array}
  | {readonly kind: 'abstain'}
  | {readonly kind: 'no_confidence'}

const drepOf = (d: DecodedDRep): ReviewedDRep => {
  switch (d.kind) {
    case 'key':
      return {type: 'key_hash', keyHashHex: hx(d.hash)}
    case 'script':
      return {type: 'script_hash', scriptHashHex: hx(d.hash)}
    case 'abstain':
      return {type: 'abstain'}
    case 'no_confidence':
      return {type: 'no_confidence'}
  }
}

const anchorOf = (a: {url: string; dataHash: Uint8Array} | undefined) =>
  a === undefined ? undefined : {url: a.url, dataHashHex: hx(a.dataHash)}

const govActionIdOf = (g: {txId: Uint8Array; index: bigint}): ReviewedGovActionId => ({
  txHashHex: hx(g.txId),
  index: Number(g.index),
})

const optGovActionId = (g: {txId: Uint8Array; index: bigint} | undefined) =>
  g === undefined ? undefined : govActionIdOf(g)

const voterOf = (v: Analyze.Voter): ReviewedVoter => {
  if (v.role === 'pool') return {role: 'pool', keyHashHex: hx(v.keyHash)}
  return {role: v.role, credential: credOf(v.cred)}
}

const govActionOf = (a: Analyze.ProposalProcedure['govAction']): ReviewedGovAction => {
  switch (a.type) {
    case 'parameter_change':
      return {
        type: 'parameter_change',
        ...opt('prev', optGovActionId(a.prev)),
        paramUpdateHex: hx(a.paramUpdate),
        ...opt('policyHashHex', a.policyHash !== undefined ? hx(a.policyHash) : undefined),
      }
    case 'hard_fork':
      return {type: 'hard_fork', ...opt('prev', optGovActionId(a.prev)), major: a.major, minor: a.minor}
    case 'treasury_withdrawals':
      return {
        type: 'treasury_withdrawals',
        withdrawals: a.withdrawals.map(([rewardAccount, amount]) => ({rewardAccountHex: hx(rewardAccount), amount})),
        ...opt('policyHashHex', a.policyHash !== undefined ? hx(a.policyHash) : undefined),
      }
    case 'no_confidence':
      return {type: 'no_confidence', ...opt('prev', optGovActionId(a.prev))}
    case 'update_committee':
      return {
        type: 'update_committee',
        ...opt('prev', optGovActionId(a.prev)),
        removed: a.removed.map(credOf),
        added: a.added.map(([cred, epoch]) => ({credential: credOf(cred), epoch})),
        threshold: a.threshold,
      }
    case 'new_constitution':
      return {
        type: 'new_constitution',
        ...opt('prev', optGovActionId(a.prev)),
        anchor: {url: a.anchor.url, dataHashHex: hx(a.anchor.dataHash)},
        ...opt('scriptHashHex', a.scriptHash !== undefined ? hx(a.scriptHash) : undefined),
      }
    case 'info':
      return {type: 'info'}
  }
}

/**
 * One certificate → its extracted operation. Deposit sourcing: the cert's own
 * `deposit` field (Conway reg/dereg/reg-deleg + DRep certs), else the matching
 * protocol param (legacy Shelley stake certs → keyDeposit; pool → poolDeposit).
 */
const mapCertificate = (cert: Analyze.Certificate, params: Plan.ProtocolParams): CardanoOperation => {
  switch (cert.type) {
    case 'stake_registration':
      return {kind: 'stake-registration', credential: credOf(cert.cred), deposit: params.keyDeposit}
    case 'stake_deregistration':
      return {kind: 'stake-deregistration', credential: credOf(cert.cred), deposit: params.keyDeposit}
    case 'reg':
      return {kind: 'stake-registration', credential: credOf(cert.cred), deposit: cert.deposit}
    case 'unreg':
      return {kind: 'stake-deregistration', credential: credOf(cert.cred), deposit: cert.deposit}
    case 'stake_delegation':
      return {kind: 'stake-delegation', credential: credOf(cert.cred), poolKeyHashHex: hx(cert.pool)}
    case 'vote_delegation':
      return {kind: 'vote-delegation', credential: credOf(cert.cred), drep: drepOf(cert.drep)}
    case 'stake_vote_delegation':
      return {
        kind: 'stake-vote-delegation',
        credential: credOf(cert.cred),
        poolKeyHashHex: hx(cert.pool),
        drep: drepOf(cert.drep),
      }
    case 'stake_reg_delegation':
      return {
        kind: 'stake-reg-delegation',
        credential: credOf(cert.cred),
        poolKeyHashHex: hx(cert.pool),
        deposit: cert.deposit,
      }
    case 'vote_reg_delegation':
      return {
        kind: 'vote-reg-delegation',
        credential: credOf(cert.cred),
        drep: drepOf(cert.drep),
        deposit: cert.deposit,
      }
    case 'stake_vote_reg_delegation':
      return {
        kind: 'stake-vote-reg-delegation',
        credential: credOf(cert.cred),
        poolKeyHashHex: hx(cert.pool),
        drep: drepOf(cert.drep),
        deposit: cert.deposit,
      }
    case 'committee_hot_auth':
      return {kind: 'committee-hot-auth', cold: credOf(cert.cold), hot: credOf(cert.hot)}
    case 'committee_cold_resign':
      return {kind: 'committee-cold-resign', cold: credOf(cert.cold), ...opt('anchor', anchorOf(cert.anchor))}
    case 'drep_registration':
      return {
        kind: 'drep-registration',
        credential: credOf(cert.cred),
        deposit: cert.deposit,
        ...opt('anchor', anchorOf(cert.anchor)),
      }
    case 'drep_deregistration':
      return {kind: 'drep-deregistration', credential: credOf(cert.cred), deposit: cert.deposit}
    case 'drep_update':
      return {kind: 'drep-update', credential: credOf(cert.cred), ...opt('anchor', anchorOf(cert.anchor))}
    case 'pool_registration':
      return {kind: 'pool-registration', poolKeyHashHex: hx(cert.params.operator), deposit: params.poolDeposit}
    case 'pool_retirement':
      return {kind: 'pool-retirement', poolKeyHashHex: hx(cert.pool), epoch: cert.epoch}
    case 'other':
      return {kind: 'unknown-certificate', tag: Number(cert.tag)}
  }
}

/** Credential pair for the IO, so parties can group per stake key and the UI can inspect. */
const credentialsOf = (
  payment: {readonly hashHex: string; readonly isScript: boolean} | undefined,
  stake: {readonly hashHex: string; readonly isScript: boolean} | undefined,
): ReviewedIO['credentials'] => {
  const asCred = (c: {readonly hashHex: string; readonly isScript: boolean}) => ({
    hashHex: c.hashHex,
    type: c.isScript ? ('script' as const) : ('key' as const),
  })
  if (payment === undefined && stake === undefined) return undefined
  return {
    ...(payment !== undefined ? {payment: asCred(payment)} : {}),
    ...(stake !== undefined ? {stake: asCred(stake)} : {}),
  }
}

// No `outpoint`: these outputs do not exist yet, and the transaction they will
// belong to has no hash until it is submitted.
const outputIO = (context: WalletContext, output: Inspect.OutputView): ReviewedIO => {
  const credentials = credentialsOf(output.address.payment, output.address.stake)
  return {
    address: addressRef(output.address),
    ownership: classifyCreds(context, output.address.payment, output.address.stake),
    amounts: toAmounts(
      fromTokens(
        output.value.amount,
        output.value.tokens.map((t) => ({policyIdHex: t.policyIdHex, assetNameHex: t.assetNameHex, amount: t.amount})),
      ),
    ),
    ...(credentials !== undefined ? {credentials} : {}),
    // An inline datum is the datum; a hash means it is off-chain and this output
    // cannot be interpreted from the transaction alone. Inline wins when a body
    // somehow carries both, because it is the stronger fact.
    ...(output.inlineDatumHex !== undefined
      ? {datum: {kind: 'inline' as const, hex: output.inlineDatumHex}}
      : output.datumHashHex !== undefined
        ? {datum: {kind: 'hash' as const, hashHex: output.datumHashHex}}
        : {}),
    ...(output.referenceScriptHex !== undefined ? {refScript: {hex: output.referenceScriptHex}} : {}),
  }
}

const resolvedInputIO = (context: WalletContext, resolved: ResolvedInput): ReviewedIO => {
  const info = Address.inspect(resolved.addressHex)
  const payment =
    info.paymentCredHex !== undefined
      ? {hashHex: info.paymentCredHex, isScript: info.paymentIsScript === true}
      : undefined
  const stake =
    info.stakeCredHex !== undefined ? {hashHex: info.stakeCredHex, isScript: info.stakeIsScript === true} : undefined
  const credentials = credentialsOf(payment, stake)
  return {
    address: addressRef({
      hex: resolved.addressHex,
      ...(resolved.addressBech32 !== undefined ? {bech32: resolved.addressBech32} : {}),
    }),
    ownership: classifyCreds(context, payment, stake),
    amounts: toAmounts(fromTokens(resolved.coin, resolved.tokens)),
    ...(credentials !== undefined ? {credentials} : {}),
    outpoint: {txHashHex: resolved.txHashHex, index: resolved.index},
    ...(resolved.fromUnconfirmedTx === true ? {fromUnconfirmedTx: true} : {}),
  }
}

/**
 * Review a Cardano transaction body against the wallet. `resolvedInputs` are the
 * tx inputs the wallet recognized in its UTxO set — inputs without a match are
 * surfaced under `unresolvedInputs`. `params` sources cert deposits; `witnessHex`
 * (optional) populates the script summary + witness set for the detail views.
 */
export const reviewCardanoTx = (
  bodyHex: string,
  context: WalletContext,
  resolvedInputs: readonly ResolvedInput[],
  params: Plan.ProtocolParams,
  witnessHex?: string,
  /**
   * Where the fee went, when *we* built the transaction. Absent for externally
   * supplied bodies (dApp signTx, co-sign), which fall back to the flat cap.
   */
  feeBreakdown?: Plan.FeeBreakdown,
  /**
   * The transaction's auxiliary data (CBOR hex), when there is any.
   *
   * The body commits only to the aux-data *hash*, so without the aux itself a
   * review can show that hash and never the metadata it stands for. Decoded here
   * rather than supplied pre-parsed, so what the reader sees comes from the same
   * bytes that get signed. Absent means "no aux / unknown", never "no metadata".
   */
  auxHex?: string,
  /**
   * Whether a witness's signature leaks the key that made it, already bound to
   * this transaction's signed message. Injected because the check is Ed25519
   * curve arithmetic and this package stays crypto-free; absent means the
   * question was not asked, which is not the same as "no leak".
   */
  leaksSigningKey?: (vkeyHex: string, signatureHex: string) => boolean,
): Effect.Effect<ReviewedTransaction, CborError | Analyze.DecodeError, Decode> =>
  Effect.gen(function* () {
    const {body} = yield* Inspect.txBody(bodyHex)
    const certs = (yield* Analyze.certificates(bodyHex)) ?? []
    const mint = yield* Analyze.mint(bodyHex)
    const voting = yield* Analyze.votingProcedures(bodyHex)
    const proposals = (yield* Analyze.proposalProcedures(bodyHex)) ?? []
    const analyzed = yield* Analyze.review(bodyHex, witnessHex)
    const witnessSet = witnessHex !== undefined ? yield* Inspect.witnessSetVkeys(witnessHex) : undefined
    // `witnessSetEntries` returns every entry except the vkey witnesses (key 0),
    // so key 2 is counted from what is already decoded rather than re-read.
    const bootstrapWitnesses =
      witnessHex === undefined
        ? undefined
        : (yield* Inspect.witnessSetEntries(witnessHex)).filter(([key]) => key === 2).length
    const requiredSigners = body.signers ?? []
    const requiredSignerSet = new Set(requiredSigners)
    const witnesses = witnessSet?.map((w): ReviewedVkeyWitness => {
      // A witness that cannot be hashed cannot be matched against anything. Say
      // so by omission rather than by reporting "not yours" / "not required".
      const keyHashHex = tryKeyHash(w.vkeyHex)
      const owner = keyHashHex === undefined ? undefined : keyHashOwner(context, keyHashHex)
      return {
        vkeyHex: w.vkeyHex,
        signatureHex: w.sigHex,
        ...(keyHashHex !== undefined ? {keyHashHex} : {}),
        ...(owner !== undefined ? {owner} : {}),
        satisfiesRequiredSigner: keyHashHex !== undefined && requiredSignerSet.has(keyHashHex),
        leaksSigningKey: leaksSigningKey?.(w.vkeyHex, w.sigHex) === true,
      }
    })
    // Undecodable aux must not sink the whole review — the transaction is still
    // reviewable without its metadata, and the aux-data hash row still shows that
    // something is attached.
    const metadata =
      auxHex !== undefined && auxHex.length > 0
        ? yield* Inspect.metadata(auxHex).pipe(Effect.orElseSucceed(() => ({})))
        : {}

    const resolvedByRef = new Map(resolvedInputs.map((r) => [inputKey(r.txHashHex, r.index), r]))
    const inputs: ReviewedIO[] = []
    const unresolvedInputs: InputRef[] = []
    for (const input of body.inputs) {
      const resolved = resolvedByRef.get(inputKey(input.txHashHex, input.index))
      if (resolved) inputs.push(resolvedInputIO(context, resolved))
      else unresolvedInputs.push({txHashHex: input.txHashHex, index: input.index})
    }
    const outputs = body.outputs.map((o) => outputIO(context, o))
    const {ownGroup, identityGroup, escrowGroup, otherGroup} = buildGroups(inputs, outputs)

    // ── operations ──
    const operations: ReviewedOperation[] = certs.map((c) => mapCertificate(c, params))

    const ownDelta = ownDeltaValue(inputs, outputs)

    for (const withdrawal of body.withdrawals ?? []) {
      const own =
        !withdrawal.credential.isScript &&
        context.stakeKeyHashHex !== undefined &&
        withdrawal.credential.hashHex === context.stakeKeyHashHex
      operations.push({
        kind: 'reward-withdrawal',
        rewardAddress: addressRef(withdrawal.rewardAddress),
        amount: withdrawal.amount,
        own,
      })
    }

    for (const [policy, assets] of mint ?? []) {
      const minted = assets.map(([name, quantity]) => ({assetNameHex: hx(name), quantity}))
      operations.push({
        kind: 'minting',
        policyIdHex: hx(policy),
        assets: minted,
        burns: minted.some((a) => a.quantity < 0n),
      })
    }

    if (voting !== undefined && voting.length > 0) {
      const votes: ReviewedVote[] = []
      for (const [voter, actionVotes] of voting) {
        for (const [gaid, vp] of actionVotes) {
          votes.push({
            voter: voterOf(voter),
            govActionId: govActionIdOf(gaid),
            choice: vp.vote,
            ...opt('anchor', anchorOf(vp.anchor)),
          })
        }
      }
      operations.push({kind: 'voting-procedures', votes})
    }

    if (proposals.length > 0) {
      const mapped: ReviewedProposal[] = proposals.map((p) => ({
        deposit: p.deposit,
        rewardAccountHex: hx(p.rewardAccount),
        action: govActionOf(p.govAction),
        anchor: {url: p.anchor.url, dataHashHex: hx(p.anchor.dataHash)},
      }))
      operations.push({kind: 'proposal-procedures', proposals: mapped})
    }

    if (body.witnessHash !== undefined) {
      operations.push({
        kind: 'contract-execution',
        scriptDataHashHex: body.witnessHash,
        collateralInputs: body.collateral?.inputs.length ?? 0,
        ...(body.collateral?.balance !== undefined ? {totalCollateral: body.collateral.balance} : {}),
      })
    }

    // ── warnings ──
    const warnings = new Set<TransactionWarning>()
    // First, so it heads the banner list: everything else here is advice, this
    // one is a key that is already gone.
    if (witnesses?.some((w) => w.leaksSigningKey)) warnings.add('leaked-signing-key')
    const feePercent = feeBreakdown === undefined ? undefined : Plan.feePercentOfSent(feeBreakdown)
    // A fee that is exactly the protocol's linear minimum cannot be "unusually
    // large" at any ratio — see LARGE_FEE_PERCENT_OF_SENT.
    const aboveProtocolMinimum = feeBreakdown !== undefined && feeBreakdown.total > feeBreakdown.linear
    const disproportionate = aboveProtocolMinimum && feePercent !== undefined && feePercent > LARGE_FEE_PERCENT_OF_SENT
    if (body.fee > LARGE_FEE_LOVELACE || disproportionate) warnings.add('large-fee')
    // "Your change was converted into fee" is a different and more alarming
    // statement than "the fee is large", so it gets its own warning.
    if (feeBreakdown !== undefined && feeBreakdown.foldedFromChange > 0n) warnings.add('change-folded-into-fee')
    if (body.ttl === undefined) warnings.add('no-ttl')
    for (const op of operations) {
      if (op.kind === 'minting') warnings.add(op.burns ? 'burning' : 'minting')
      if (op.kind === 'voting-procedures' || op.kind === 'proposal-procedures') warnings.add('governance-action')
      if (op.kind === 'contract-execution') warnings.add('plutus-contract')
      if (op.kind === 'unknown-certificate') warnings.add('unknown-certificate')
    }
    // A script certificate is worth flagging when the script is somebody else's:
    // it says this transaction is acting on a credential a policy controls rather
    // than a key. A *shared wallet delegating itself* is the same shape and means
    // nothing of the kind — it is the only way such a wallet can ever stake — so
    // warning there attaches an alarm to the ordinary case and teaches the user to
    // ignore the banner in the case that matters.
    const ownStakeScriptHex = context.stakeIsScript === true ? (context.stakeKeyHashHex?.toLowerCase() ?? null) : null
    for (const cert of certs) {
      const foreign = Analyze.certificateCredentials(cert).some(
        (cred) => cred.isScript && hx(cred.hash).toLowerCase() !== ownStakeScriptHex,
      )
      if (foreign) warnings.add('script-certificate')
    }
    // An address carrying our stake credential under a foreign payment key. We
    // earn its rewards but cannot spend it, and it is the shape of a mangled /
    // delegation-hijack address — worth surfacing even though the funds are not
    // at risk in this tx.
    if ([...inputs, ...outputs].some((io) => io.ownership.level === 'stake-hijack')) {
      warnings.add('stake-credential-reuse')
    }
    if (endsExternalDelegation(context, inputs, outputs)) warnings.add('ends-external-delegation')
    // Spending an output that is not on chain yet makes this transaction
    // contingent: if its parent never lands, this one cannot either.
    if (inputs.some((io) => io.fromUnconfirmedTx === true)) warnings.add('spends-unconfirmed-input')
    if (unresolvedInputs.length > 0) warnings.add('unresolved-inputs')
    if (body.unknownKeys.length > 0) warnings.add('unknown-body-fields')
    if (body.treasury !== undefined || body.donation !== undefined) warnings.add('treasury-donation')
    // "Needs another signature" means another *party*, not another key. Every required
    // signer that is one of ours is signed in the same ceremony with no further action, so
    // flagging those told the user to wait for something that was never coming — and a
    // transaction requiring our own payment and stake keys (a script authorising on the
    // stake credential, say) is completely ordinary. Only a required signer we hold no key
    // for makes this multi-party.
    const ownSignerHashes = new Set<string>([
      ...context.paymentKeyHashes,
      ...(context.stakeKeyHashHex === undefined ? [] : [context.stakeKeyHashHex]),
      ...(context.identity?.paymentKeyHashes ?? []),
      ...(context.identity?.stakeKeyHashHex === undefined ? [] : [context.identity.stakeKeyHashHex]),
    ])
    const foreignRequiredSigner = (body.signers ?? []).some((hash) => !ownSignerHashes.has(hash.toLowerCase()))
    // A native script can encode a quorum of keys we do not enumerate, so it remains a
    // multi-party signal on its own.
    if (foreignRequiredSigner || analyzed.scripts.native > 0) warnings.add('multi-sig')

    const scripts: ScriptSummary = analyzed.scripts
    const counterparties = counterpartiesOf(otherGroup)

    return {
      chain: 'cardano',
      ...(body.networkId !== undefined ? {networkId: body.networkId} : {}),
      fee: body.fee,
      ...(body.ttl !== undefined ? {ttl: body.ttl} : {}),
      ...(body.validityIntervalStart !== undefined ? {validityIntervalStart: body.validityIntervalStart} : {}),
      inputs,
      unresolvedInputs,
      outputs,
      referenceInputs: (body.references ?? []).map((r) => ({txHashHex: r.txHashHex, index: r.index})),
      ...(body.collateral !== undefined
        ? {
            collateral: {
              inputs: body.collateral.inputs.map((i) => ({txHashHex: i.txHashHex, index: i.index})),
              ...(body.collateral.output !== undefined
                ? {returnOutput: outputIO(context, body.collateral.output)}
                : {}),
              ...(body.collateral.balance !== undefined ? {balance: body.collateral.balance} : {}),
            },
          }
        : {}),
      ...(body.witnessHash !== undefined ? {scriptDataHashHex: body.witnessHash} : {}),
      ...(body.auxiliaryDataHashHex !== undefined ? {auxiliaryDataHashHex: body.auxiliaryDataHashHex} : {}),
      cbor: {hex: bodyHex, kind: 'body'},
      metadata,
      requiredSigners,
      ...(witnesses !== undefined ? {witnessSet: witnesses} : {}),
      ...(bootstrapWitnesses !== undefined ? {bootstrapWitnesses} : {}),
      scripts,
      ownDelta: toAmounts(ownDelta),
      ownGroup,
      identityGroup,
      escrowGroup,
      otherGroup,
      counterparties,
      operations,
      warnings: [...warnings],
    } satisfies ReviewedTransaction
  })
