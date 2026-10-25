/**
 * Reading a builder's arguments off a `tools/call`, before anything is built.
 *
 * Pure and in its own module so every refusal is testable without a rail, a screen or a wallet — and
 * because the refusals *are* the interface here. An agent chooses what to send from a JSON schema and a
 * description; when it gets one of them wrong the sentence it reads back is the only thing that tells it
 * what to change, so each of these names the field and what was wrong with it.
 *
 * ⚠️ **Amounts are decimal strings, never JSON numbers.** A lovelace figure passes 2^53 at ~9 M ADA and
 * a token quantity can be far larger; a number would be silently rounded on the way in, which is the one
 * class of error nobody sees until the transaction is on chain. Refusing a number outright is what makes
 * that impossible rather than unlikely.
 *
 * @module
 */

import type {ArgResult} from './local-tools'

/** ADA's key in a target's amount map — the empty asset id, as the send flow spells it. */
const ADA_KEY = ''

/** One recipient, still holding the address as the caller wrote it: resolving it needs a codec. */
export type ParsedOutput = {
  /** Bech32, exactly as given. Validated against the wallet's own network where it is resolved. */
  readonly address: string
  /** `'' → lovelace`, `'{policyId}.{assetNameHex}' → quantity`, matching `ResolvedTarget`. */
  readonly amounts: ReadonlyMap<string, bigint>
  /**
   * Whether the caller named a lovelace amount at all.
   *
   * ⚠️ **Absent and zero are different instructions**, and the min-ADA floor is why. An output carrying
   * assets must hold a minimum of ADA or the ledger refuses it — so an *omitted* amount means "whatever
   * this output needs", while a stated one below that floor is a contradiction. Raising a stated amount
   * silently would send more ADA than the caller said.
   */
  readonly lovelaceGiven: boolean
}

export type ParsedTransfer = {
  readonly outputs: readonly ParsedOutput[]
  readonly memo?: string
  /**
   * Whether the wallet should carry it through to the chain after the person approves.
   *
   * ⚠️ **Off by default, which is the family's invariant**: a builder hands back an unsigned
   * transaction and nothing more. `true` is the option that makes it reachable — an agent has no way to
   * assemble a witness set and broadcast on its own — and it still opens the review screen.
   */
  readonly submit: boolean
}

const fail = (message: string): ArgResult<never> => ({ok: false, message})

/** A required non-empty string field. */
export const readString = (value: unknown, field: string): ArgResult<string> =>
  typeof value === 'string' && value.length > 0 ? {ok: true, value} : fail(`\`${field}\` must be a non-empty string`)

/**
 * A non-negative integer written as a decimal string.
 *
 * ⚠️ A JSON number is refused rather than coerced. `3000000000000000000` arrives as a float that is not
 * the number that was written, and nothing downstream can tell.
 */
export const readAmount = (value: unknown, field: string): ArgResult<bigint> => {
  if (typeof value === 'number') {
    return fail(`\`${field}\` must be a decimal STRING, not a number — a JSON number cannot hold an exact amount`)
  }
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    return fail(`\`${field}\` must be a whole amount in atomic units, written as decimal digits in a string`)
  }
  return {ok: true, value: BigInt(value)}
}

/** Lowercase hex of an exact byte length, or any length when `bytes` is omitted. */
export const readHex = (value: unknown, field: string, bytes?: number): ArgResult<string> => {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
    return fail(`\`${field}\` must be hex, an even number of characters`)
  }
  if (bytes !== undefined && value.length !== bytes * 2) {
    return fail(`\`${field}\` must be exactly ${bytes} bytes (${bytes * 2} hex characters); got ${value.length / 2}`)
  }
  return {ok: true, value: value.toLowerCase()}
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * One output's asset list, folded into the amount map beside its lovelace.
 *
 * ⚠️ Two entries naming the same asset are **added**, not overwritten. An agent building a list from
 * several sources can easily emit a duplicate, and silently keeping the last one would send less than it
 * asked for — the kind of loss that is only visible on chain.
 */
const readAssets = (raw: unknown, where: string, into: Map<string, bigint>): ArgResult<null> => {
  if (raw === undefined || raw === null) return {ok: true, value: null}
  if (!Array.isArray(raw)) return fail(`\`${where}.assets\` must be a list`)
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry)) return fail(`\`${where}.assets[${i}]\` must be an object`)
    const policy = readHex(entry.policyId, `${where}.assets[${i}].policyId`, 28)
    if (!policy.ok) return policy
    const name = readHex(entry.assetName ?? '', `${where}.assets[${i}].assetName`)
    if (!name.ok) return name
    if (name.value.length > 64) return fail(`\`${where}.assets[${i}].assetName\` cannot exceed 32 bytes`)
    const quantity = readAmount(entry.quantity, `${where}.assets[${i}].quantity`)
    if (!quantity.ok) return quantity
    if (quantity.value === 0n) return fail(`\`${where}.assets[${i}].quantity\` must be more than zero`)
    const key = `${policy.value}.${name.value}`
    into.set(key, (into.get(key) ?? 0n) + quantity.value)
  }
  return {ok: true, value: null}
}

/** One recipient: an address, an optional lovelace amount, an optional asset list. */
export const readOutput = (raw: unknown, where: string): ArgResult<ParsedOutput> => {
  if (!isRecord(raw)) return fail(`\`${where}\` must be an object with an address`)
  const address = readString(raw.address, `${where}.address`)
  if (!address.ok) return address
  const amounts = new Map<string, bigint>()
  const lovelaceGiven = raw.lovelace !== undefined && raw.lovelace !== null
  if (lovelaceGiven) {
    const lovelace = readAmount(raw.lovelace, `${where}.lovelace`)
    if (!lovelace.ok) return lovelace
    amounts.set(ADA_KEY, lovelace.value)
  }
  const assets = readAssets(raw.assets, where, amounts)
  if (!assets.ok) return assets
  if (amounts.size === 0) return fail(`\`${where}\` sends nothing — give it \`lovelace\`, \`assets\`, or both`)
  // Zero stands in until the floor is known — see {@link ParsedOutput.lovelaceGiven}, which is what
  // tells the builder whether to raise it or to hold the caller to what they wrote.
  if (!amounts.has(ADA_KEY)) amounts.set(ADA_KEY, 0n)
  return {ok: true, value: {address: address.value, amounts, lovelaceGiven}}
}

const readBoolean = (value: unknown, field: string, fallback: boolean): ArgResult<boolean> => {
  if (value === undefined || value === null) return {ok: true, value: fallback}
  if (typeof value !== 'boolean') return fail(`\`${field}\` must be true or false`)
  return {ok: true, value}
}

/**
 * How many recipients one call may name.
 *
 * Roughly 240 plain ADA outputs fit one transaction and the wallet will chain at most five in a single
 * review, so about 1,200 is the ceiling that can actually be paid. This sits under it: the search that
 * splits a list into legs builds to measure, and a list far past what can be approved would spend a
 * minute building transactions nobody will ever see.
 */
export const MAX_TRANSFER_OUTPUTS = 1000

export const readTransferArgs = (args: Record<string, unknown>): ArgResult<ParsedTransfer> => {
  const raw = args.outputs
  if (!Array.isArray(raw) || raw.length === 0) return fail('`outputs` must be a list with at least one recipient')
  if (raw.length > MAX_TRANSFER_OUTPUTS) {
    return fail(
      `\`outputs\` has ${raw.length} recipients, past the ${MAX_TRANSFER_OUTPUTS} one call may name. The ` +
        'wallet splits a long list across chained transactions and reviews them together, but only five ' +
        'of them at a time — send the rest once these have landed.',
    )
  }
  const outputs: ParsedOutput[] = []
  for (const [i, entry] of raw.entries()) {
    const output = readOutput(entry, `outputs[${i}]`)
    if (!output.ok) return output
    outputs.push(output.value)
  }
  const submit = readBoolean(args.submit, 'submit', false)
  if (!submit.ok) return submit
  if (args.memo !== undefined && args.memo !== null) {
    const memo = readString(args.memo, 'memo')
    if (!memo.ok) return memo
    return {ok: true, value: {outputs, memo: memo.value, submit: submit.value}}
  }
  return {ok: true, value: {outputs, submit: submit.value}}
}

// ── programmable transfer (CIP-113) ──

/**
 * How many recipients one programmable transfer may name.
 *
 * ⚠️ **Deliberately far below the ordinary transfer's cap.** Every recipient adds a smart-wallet
 * output and its share of the Plutus execution budget, and `MAX_PLB_INPUTS` is 74 rather than the
 * framework's 86 because 2M mem is reserved for substandards whose cost is the issuer's to decide.
 * A list that does not fit is refused here rather than failing at submit.
 */
export const MAX_PROGRAMMABLE_RECIPIENTS = 20

export type ParsedProgrammableTransfer = {
  readonly outputs: readonly ParsedOutput[]
  readonly submit: boolean
}

/**
 * Recipients and the programmable assets each is to receive.
 *
 * ⚠️ **No `lovelace` field, and naming one is an error rather than being ignored.** A programmable
 * transfer moves tokens between smart wallets; the ada travelling with them is the min-ADA the
 * ledger requires on those outputs, which the builder sets. An agent that asked to send ada here
 * and was silently given none would have been told the transfer succeeded.
 */
export const readProgrammableTransferArgs = (args: Record<string, unknown>): ArgResult<ParsedProgrammableTransfer> => {
  const raw = args.outputs
  if (!Array.isArray(raw) || raw.length === 0) return fail('`outputs` must be a list with at least one recipient')
  if (raw.length > MAX_PROGRAMMABLE_RECIPIENTS) {
    return fail(
      `\`outputs\` has ${raw.length} recipients, past the ${MAX_PROGRAMMABLE_RECIPIENTS} one programmable ` +
        'transfer may name. Each one costs a smart-wallet output and part of a fixed Plutus execution ' +
        'budget, so send the rest once these have landed.',
    )
  }
  const outputs: ParsedOutput[] = []
  for (const [i, entry] of raw.entries()) {
    if (typeof entry === 'object' && entry !== null && 'lovelace' in entry) {
      return fail(
        `\`outputs[${i}].lovelace\` is not accepted: a programmable transfer moves tokens, and the ada on ` +
          'each output is the min-ADA the ledger requires, which the wallet sets. Send ada with ' +
          'cardano_buildTransfer.',
      )
    }
    const output = readOutput(entry, `outputs[${i}]`)
    if (!output.ok) return output
    if (output.value.amounts.size === 0) {
      return fail(`\`outputs[${i}]\` names no assets — a programmable transfer with nothing to move is not a send`)
    }
    outputs.push(output.value)
  }
  const submit = readBoolean(args.submit, 'submit', false)
  if (!submit.ok) return submit
  return {ok: true, value: {outputs, submit: submit.value}}
}

// ── mint and distribute ──

/** One recipient of a mint: an address and how many of the new asset it gets. */
export type ParsedMintRecipient = {readonly address: string; readonly quantity: bigint}

export type ParsedMint = {
  /** The asset name as bytes, hex. Empty is legal and means a nameless asset. */
  readonly assetNameHex: string
  /** The name as text when it is valid UTF-8 — CIP-25 v1 keys the metadata by it. */
  readonly assetNameText: string | null
  readonly quantity: bigint
  readonly recipients: readonly ParsedMintRecipient[]
  readonly lockAfterSlot?: number
  /** CIP-25 fields for this asset, unencoded. */
  readonly metadata?: Record<string, unknown>
  readonly submit: boolean
}

/** How many recipients one mint may name. The same transaction ceiling the transfer builder has. */
export const MAX_MINT_RECIPIENTS = MAX_TRANSFER_OUTPUTS

/**
 * The asset name as the caller gave it: `assetName` is text, `assetNameHex` is bytes, and exactly one
 * may be given.
 *
 * ⚠️ **Both would be a contradiction nobody could resolve**, and picking one silently is how an asset
 * ends up minted under a name its own metadata does not key.
 */
const readAssetName = (args: Record<string, unknown>): ArgResult<{hex: string; text: string | null}> => {
  const hasText = args.assetName !== undefined && args.assetName !== null
  const hasHex = args.assetNameHex !== undefined && args.assetNameHex !== null
  if (hasText && hasHex) return fail('give `assetName` or `assetNameHex`, not both — they would have to agree')
  if (hasHex) {
    const hex = readHex(args.assetNameHex, 'assetNameHex')
    if (!hex.ok) return hex
    if (hex.value.length > 64) return fail('`assetNameHex` cannot exceed 32 bytes')
    // ⚠️ A round-trip rather than a fatal decoder in a `try`: bytes that are not text are perfectly
    // legal for an asset name, so this is a question being asked, not a failure being swallowed. It
    // only decides whether CIP-25 v1 — which keys metadata by the name as *text* — can describe it.
    return {ok: true, value: {hex: hex.value, text: asUtf8(hex.value)}}
  }
  if (!hasText) return fail('give the asset a name with `assetName` (text) or `assetNameHex` (bytes)')
  const name = typeof args.assetName === 'string' ? args.assetName : null
  if (name === null) return fail('`assetName` must be a string')
  const bytes = new TextEncoder().encode(name)
  if (bytes.length > 32) return fail(`\`assetName\` is ${bytes.length} bytes; an asset name may not exceed 32`)
  return {ok: true, value: {hex: [...bytes].map((b) => b.toString(16).padStart(2, '0')).join(''), text: name}}
}

export const readMintArgs = (args: Record<string, unknown>): ArgResult<ParsedMint> => {
  const name = readAssetName(args)
  if (!name.ok) return name
  const raw = args.recipients
  if (!Array.isArray(raw) || raw.length === 0) return fail('`recipients` must be a list with at least one entry')
  if (raw.length > MAX_MINT_RECIPIENTS) {
    return fail(
      `\`recipients\` has ${raw.length} entries; one transaction cannot hold nearly that many. Mint once with ` +
        `up to ${MAX_MINT_RECIPIENTS}, then send the rest with cardano_buildTransfer.`,
    )
  }
  const recipients: ParsedMintRecipient[] = []
  let distributed = 0n
  for (const [i, entry] of raw.entries()) {
    if (!isRecord(entry)) return fail(`\`recipients[${i}]\` must be an object`)
    const address = readString(entry.address, `recipients[${i}].address`)
    if (!address.ok) return address
    const quantity = readAmount(entry.quantity, `recipients[${i}].quantity`)
    if (!quantity.ok) return quantity
    if (quantity.value === 0n) return fail(`\`recipients[${i}].quantity\` must be more than zero`)
    distributed += quantity.value
    recipients.push({address: address.value, quantity: quantity.value})
  }
  const quantity =
    args.quantity === undefined || args.quantity === null
      ? ({ok: true, value: distributed} as ArgResult<bigint>)
      : readAmount(args.quantity, 'quantity')
  if (!quantity.ok) return quantity
  if (quantity.value < distributed) {
    return fail(
      `\`quantity\` is ${quantity.value} but the recipients are given ${distributed} between them. ` +
        'Mint at least what you hand out; anything over comes back to this wallet.',
    )
  }
  const lock = readOptionalSlot(args.lockAfterSlot)
  if (!lock.ok) return lock
  const submit = readBoolean(args.submit, 'submit', false)
  if (!submit.ok) return submit
  const metadata = args.metadata
  if (metadata !== undefined && metadata !== null) {
    if (!isRecord(metadata)) return fail('`metadata` must be an object of CIP-25 fields')
    if (name.value.text === null) {
      return fail('`metadata` needs an asset name that is valid text — CIP-25 keys it by the name, not by its bytes')
    }
  }
  return {
    ok: true,
    value: {
      assetNameHex: name.value.hex,
      assetNameText: name.value.text,
      quantity: quantity.value,
      recipients,
      submit: submit.value,
      ...(lock.value !== undefined ? {lockAfterSlot: lock.value} : {}),
      ...(isRecord(metadata) ? {metadata} : {}),
    },
  }
}

/** These bytes read back as the same bytes when treated as UTF-8, or `null` when they are not text. */
const asUtf8 = (hex: string): string | null => {
  const bytes = Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16))
  const decoded = new TextDecoder().decode(bytes)
  const reencoded = new TextEncoder().encode(decoded)
  if (reencoded.length !== bytes.length) return null
  return reencoded.every((b, i) => b === bytes[i]) ? decoded : null
}

/** An absolute slot, or nothing. Whether it is in the future is checked against the tip, not here. */
const readOptionalSlot = (value: unknown): ArgResult<number | undefined> => {
  if (value === undefined || value === null) return {ok: true, value: undefined}
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    return fail('`lockAfterSlot` must be a whole slot number')
  }
  return {ok: true, value}
}

// ── delegation ──

export type ParsedDelegation = {
  /** `pool1…` bech32, or `null` to leave the pool as it is. */
  readonly pool: string | null
  /** A DRep id, `abstain`, `no_confidence`, or `null` to leave the vote delegation as it is. */
  readonly drep: string | null
  readonly submit: boolean
}

/**
 * ⚠️ **Both absent is refused rather than treated as "keep everything".** A delegation that changes
 * nothing still costs a fee, and the builder would answer "nothing to do" after a full build — this
 * says so before anything is spent or built.
 */
export const readDelegationArgs = (args: Record<string, unknown>): ArgResult<ParsedDelegation> => {
  const hasPool = args.pool !== undefined && args.pool !== null
  const hasDrep = args.drep !== undefined && args.drep !== null
  if (!hasPool && !hasDrep) return fail('give a `pool`, a `drep`, or both — there is nothing to delegate otherwise')
  let pool: string | null = null
  if (hasPool) {
    const value = readString(args.pool, 'pool')
    if (!value.ok) return value
    if (!value.value.startsWith('pool1')) return fail('`pool` must be a bech32 pool id beginning `pool1`')
    pool = value.value
  }
  let drep: string | null = null
  if (hasDrep) {
    const value = readString(args.drep, 'drep')
    if (!value.ok) return value
    drep = value.value
  }
  const submit = readBoolean(args.submit, 'submit', false)
  if (!submit.ok) return submit
  return {ok: true, value: {pool, drep, submit: submit.value}}
}

// ── consolidation ──

export type ParsedConsolidation = {
  /** Overrides for the wallet's own stored optimisation policy; absent means "use what the person set". */
  readonly withdrawRewards?: boolean
  readonly bundleByPolicy?: boolean
  readonly keepPureAdaOutput?: boolean
  readonly maxInputsPerTx?: number
  readonly submit: boolean
}

const readOptionalBoolean = (value: unknown, field: string): ArgResult<boolean | undefined> => {
  if (value === undefined || value === null) return {ok: true, value: undefined}
  if (typeof value !== 'boolean') return fail(`\`${field}\` must be true or false`)
  return {ok: true, value}
}

/**
 * ⚠️ **Every knob is optional and absent means the wallet's own setting**, not a default invented here.
 * The person configured how their wallet folds UTxOs; an agent that silently substituted its own idea
 * of tidy would produce a different wallet shape than the one they asked for.
 */
export const readConsolidationArgs = (args: Record<string, unknown>): ArgResult<ParsedConsolidation> => {
  const withdrawRewards = readOptionalBoolean(args.withdrawRewards, 'withdrawRewards')
  if (!withdrawRewards.ok) return withdrawRewards
  const bundleByPolicy = readOptionalBoolean(args.bundleByPolicy, 'bundleByPolicy')
  if (!bundleByPolicy.ok) return bundleByPolicy
  const keepPureAdaOutput = readOptionalBoolean(args.keepPureAdaOutput, 'keepPureAdaOutput')
  if (!keepPureAdaOutput.ok) return keepPureAdaOutput
  const maxInputs =
    args.maxInputsPerTx === undefined || args.maxInputsPerTx === null
      ? ({ok: true, value: undefined} as ArgResult<number | undefined>)
      : readBoundedIntegerArg(args.maxInputsPerTx, 'maxInputsPerTx', 2, 500)
  if (!maxInputs.ok) return maxInputs
  const submit = readBoolean(args.submit, 'submit', false)
  if (!submit.ok) return submit
  return {
    ok: true,
    value: {
      ...(withdrawRewards.value !== undefined ? {withdrawRewards: withdrawRewards.value} : {}),
      ...(bundleByPolicy.value !== undefined ? {bundleByPolicy: bundleByPolicy.value} : {}),
      ...(keepPureAdaOutput.value !== undefined ? {keepPureAdaOutput: keepPureAdaOutput.value} : {}),
      ...(maxInputs.value !== undefined ? {maxInputsPerTx: maxInputs.value} : {}),
      submit: submit.value,
    },
  }
}

const readBoundedIntegerArg = (value: unknown, field: string, min: number, max: number): ArgResult<number> =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? {ok: true, value}
    : fail(`\`${field}\` must be a whole number between ${min} and ${max}`)

// ── publishing a script ──

export type ParsedDeploy = {
  readonly version: 'native' | 'plutusV1' | 'plutusV2' | 'plutusV3'
  readonly scriptHex: string
  /** Bech32, or `null` for this wallet's own address — where the reference UTxO will sit. */
  readonly address: string | null
  readonly datumHex?: string
  readonly lovelace?: bigint
  readonly submit: boolean
}

const SCRIPT_VERSIONS = new Set(['native', 'plutusV1', 'plutusV2', 'plutusV3'])

export const readDeployArgs = (args: Record<string, unknown>): ArgResult<ParsedDeploy> => {
  const version = args.version
  if (typeof version !== 'string' || !SCRIPT_VERSIONS.has(version)) {
    return fail('`version` must be one of native, plutusV1, plutusV2, plutusV3')
  }
  const scriptHex = readHex(args.scriptHex, 'scriptHex')
  if (!scriptHex.ok) return scriptHex
  if (scriptHex.value.length === 0) return fail('`scriptHex` is empty — there is no script to publish')
  let address: string | null = null
  if (args.address !== undefined && args.address !== null) {
    const value = readString(args.address, 'address')
    if (!value.ok) return value
    address = value.value
  }
  let datumHex: string | undefined
  if (args.datumHex !== undefined && args.datumHex !== null) {
    const value = readHex(args.datumHex, 'datumHex')
    if (!value.ok) return value
    datumHex = value.value
  }
  let lovelace: bigint | undefined
  if (args.lovelace !== undefined && args.lovelace !== null) {
    const value = readAmount(args.lovelace, 'lovelace')
    if (!value.ok) return value
    lovelace = value.value
  }
  const submit = readBoolean(args.submit, 'submit', false)
  if (!submit.ok) return submit
  return {
    ok: true,
    value: {
      version: version as ParsedDeploy['version'],
      scriptHex: scriptHex.value,
      address,
      submit: submit.value,
      ...(datumHex !== undefined ? {datumHex} : {}),
      ...(lovelace !== undefined ? {lovelace} : {}),
    },
  }
}

// ── co-funding: one transaction paid for by several wallets ──

/** One contributing wallet and exactly what it puts in. */
export type ParsedCoFundSource = {
  /** The granted scope key. It must be one this wallet granted; nothing else can contribute. */
  readonly scope: string
  readonly amounts: ReadonlyMap<string, bigint>
}

export type ParsedCoFund = {
  readonly sources: readonly ParsedCoFundSource[]
  readonly outputs: readonly ParsedOutput[]
}

/**
 * ⚠️ **What each wallet contributes is stated, never inferred.** A `CardanoPlan` has exactly one change
 * address, so anything a contributor puts in beyond what the recipients take would land in the
 * composer's change — somebody else's money moving somewhere nobody chose. The contributions must
 * therefore add up to the recipients exactly, per asset, and the builder refuses when they do not.
 */
export const readCoFundArgs = (args: Record<string, unknown>): ArgResult<ParsedCoFund> => {
  const rawSources = args.sources
  if (!Array.isArray(rawSources) || rawSources.length < 2) {
    return fail('`sources` must list at least two contributing wallets — one wallet is an ordinary transfer')
  }
  const sources: ParsedCoFundSource[] = []
  const seen = new Set<string>()
  for (const [i, entry] of rawSources.entries()) {
    if (!isRecord(entry)) return fail(`\`sources[${i}]\` must be an object`)
    const scope = readString(entry.scope, `sources[${i}].scope`)
    if (!scope.ok) return scope
    if (seen.has(scope.value)) return fail(`\`sources\` names ${scope.value} twice — give each wallet one entry`)
    seen.add(scope.value)
    const amounts = new Map<string, bigint>()
    if (entry.lovelace !== undefined && entry.lovelace !== null) {
      const lovelace = readAmount(entry.lovelace, `sources[${i}].lovelace`)
      if (!lovelace.ok) return lovelace
      amounts.set(ADA_KEY, lovelace.value)
    }
    const assets = readAssets(entry.assets, `sources[${i}]`, amounts)
    if (!assets.ok) return assets
    if (amounts.size === 0)
      return fail(`\`sources[${i}]\` contributes nothing — give it \`lovelace\`, \`assets\`, or both`)
    if (!amounts.has(ADA_KEY)) amounts.set(ADA_KEY, 0n)
    sources.push({scope: scope.value, amounts})
  }
  const rawOutputs = args.outputs
  if (!Array.isArray(rawOutputs) || rawOutputs.length === 0) {
    return fail('`outputs` must be a list with at least one recipient')
  }
  const outputs: ParsedOutput[] = []
  for (const [i, entry] of rawOutputs.entries()) {
    const output = readOutput(entry, `outputs[${i}]`)
    if (!output.ok) return output
    outputs.push(output.value)
  }
  return {ok: true, value: {sources, outputs}}
}

export type ParsedCoSign = {
  /** The id the build answered with — what the envelope is filed under. */
  readonly pendingId: string
}

export const readCoSignArgs = (args: Record<string, unknown>): ArgResult<ParsedCoSign> => {
  const pendingId = readString(args.pendingId, 'pendingId')
  if (!pendingId.ok) return pendingId
  return {ok: true, value: {pendingId: pendingId.value}}
}

// ── Midnight co-funding: several wallets funding one payment ──

/** One contributing Midnight wallet and exactly what it pledges. */
export type ParsedMidnightCoFundSource = {
  /** The granted scope key. It must be one this wallet granted; nothing else can contribute. */
  readonly scope: string
  /** Atomic units of `tokenType`. */
  readonly pledge: bigint
}

export type ParsedMidnightCoFund = {
  readonly sources: readonly ParsedMidnightCoFundSource[]
  /** `mn_addr…`, unshielded — this rail has no shielded equivalent. */
  readonly recipient: string
  /** 32 bytes hex. NIGHT is 32 zero bytes, which is the default when it is not named. */
  readonly tokenType: string
  readonly submit: boolean
}

/** NIGHT's token type: 32 zero bytes. Named here so the default is not a bare literal. */
const MIDNIGHT_NIGHT_TOKEN_TYPE = '00'.repeat(32)

/**
 * ⚠️ **The payment is the sum of the pledges, and there is no separate amount to state.**
 *
 * That is not a simplification of Cardano's shape, it is what the Midnight offer forces: the intent is
 * finalised before anyone signs, so every input and every output — the payment and each contributor's
 * change — is fixed at that moment (`docs/MIDNIGHT_COFUNDING_PLAN.md`). An amount stated separately
 * could disagree with the pledges, and the only way to reconcile it would be to move somebody's money
 * somewhere they did not choose.
 */
export const readMidnightCoFundArgs = (args: Record<string, unknown>): ArgResult<ParsedMidnightCoFund> => {
  const rawSources = args.sources
  if (!Array.isArray(rawSources) || rawSources.length < 2) {
    return fail('`sources` must list at least two contributing wallets — one wallet is an ordinary transfer')
  }
  const sources: ParsedMidnightCoFundSource[] = []
  const seen = new Set<string>()
  for (const [i, entry] of rawSources.entries()) {
    if (!isRecord(entry)) return fail(`\`sources[${i}]\` must be an object`)
    const scope = readString(entry.scope, `sources[${i}].scope`)
    if (!scope.ok) return scope
    if (seen.has(scope.value)) return fail(`\`sources\` names ${scope.value} twice — give each wallet one entry`)
    seen.add(scope.value)
    const pledge = readAmount(entry.pledge, `sources[${i}].pledge`)
    if (!pledge.ok) return pledge
    // A contributor of zero is refused rather than dropped: it would be signed for and hold up the
    // round while putting nothing in, and an agent that meant to omit it can omit it.
    if (pledge.value === 0n) return fail(`\`sources[${i}].pledge\` is zero — leave the wallet out instead`)
    sources.push({scope: scope.value, pledge: pledge.value})
  }
  const recipient = readString(args.recipient, 'recipient')
  if (!recipient.ok) return recipient
  const submit = readBoolean(args.submit, 'submit', false)
  if (!submit.ok) return submit
  if (args.tokenType === undefined || args.tokenType === null) {
    return {
      ok: true,
      value: {sources, recipient: recipient.value, tokenType: MIDNIGHT_NIGHT_TOKEN_TYPE, submit: submit.value},
    }
  }
  const tokenType = readHex(args.tokenType, 'tokenType', 32)
  if (!tokenType.ok) return tokenType
  return {ok: true, value: {sources, recipient: recipient.value, tokenType: tokenType.value, submit: submit.value}}
}
