/**
 * Pure send-intent model: a list of recipients (targets), each with a
 * multi-asset amount map. No React, no codec — the screen drives it and the
 * build layer (`send-flow`) turns resolved targets into a tx.
 *
 * Cross-target allocation: a given asset's balance is shared across all
 * recipients, so per-target "available" subtracts what other targets already
 * commit (and is zero if another target claims send-all of that asset).
 *
 * @module
 */

import {AddressHex} from '@evolution-sdk/review/Brands'

/** Asset id: `"<policyHex>.<assetNameHex>"`; the empty string is ADA (lovelace). */
export const ADA_ID = ''

/** Cardano's recipient ceiling. Midnight pays one recipient — {@link maxTargetsFor}. */
export const MAX_TARGETS = 5

/**
 * Which chain this send goes out on.
 *
 * Not a setting and not a picker: it is decided by the recipient's own address
 * (`services/send/recipient-rail.ts`) and the funnel adapts around it. Cardano is the resting
 * value because an empty funnel has no address to decide from yet.
 */
export type SendRail =
  | {readonly chain: 'cardano'}
  | {readonly chain: 'midnight'; readonly rail: 'unshielded' | 'shielded'}

export const CARDANO_RAIL: SendRail = {chain: 'cardano'}

/** Recipients this rail can pay in one transaction. */
export const maxTargetsFor = (rail: SendRail): number => (rail.chain === 'cardano' ? MAX_TARGETS : 1)

export type SendTarget = {
  /** Raw recipient input (bech32 address or `$handle`). */
  readonly address: string
  /** Resolved raw address bytes hex, or null until resolved/if invalid. Cardano only. */
  readonly resolvedAddressHex: string | null
  /**
   * The validated Midnight address, or null.
   *
   * A separate field rather than reusing `resolvedAddressHex`: a Midnight bech32 is not address
   * bytes hex, and writing one into a field of that name would make every Cardano reader of it
   * wrong. Which of the two is populated follows {@link SendState.rail}.
   */
  readonly resolvedMidnightAddress: string | null
  /** Resolved human name (ADA Handle) when the input was a handle. */
  readonly resolvedName: string | null
  /** assetId → quantity (base units). */
  readonly amounts: ReadonlyMap<string, bigint>
  /** assetIds flagged "send all" (amount resolved at build time). */
  readonly sendAll: ReadonlySet<string>
}

/**
 * A wallet other than the selected one putting inputs into this send.
 *
 * Co-funding is not a different kind of transaction — it is this send, funded from more
 * than one wallet — so it lives here rather than in a screen of its own. The selected
 * wallet is always the composer: it owns the change and therefore pays the fee.
 *
 * `lovelace` is what this wallet puts toward the recipients. Its surplus returns to it as
 * an explicit output; see `multiparty/compose.ts` for why that is not negotiable.
 */
export type SendSource = {
  readonly groupId: string
  readonly name: string
  /** True for the wallet building the transaction: it owns the change and pays the fee. */
  readonly isComposer: boolean
  /** What this wallet puts in. Its surplus returns to it — `multiparty/compose.ts`. */
  readonly lovelace: bigint
  /** Native tokens this wallet puts in, keyed `policyHex.nameHex`. */
  readonly assets: ReadonlyMap<string, bigint>
}

export type SendState = {
  readonly targets: readonly SendTarget[]
  readonly memo: string
  /** The chain this send is bound for, decided by the first recipient's address. */
  readonly rail: SendRail
  /**
   * The wallets funding this send, composer included.
   *
   * **Empty is the ordinary send** and every existing path stays on it. Non-empty is
   * compose mode: the transaction is multiparty, the asset totals are the *sum* of these
   * rather than something typed once, and each wallet owes a signature. Compose and queue
   * exclude each other — a queued leg chains on its own change, which is not a thing a
   * transaction owing other people's signatures can do.
   */
  readonly sources: readonly SendSource[]
}

export type SendValidationError =
  | 'noRecipients'
  | 'unresolvedAddress'
  | 'noAssets'
  | 'invalidAmount'
  | 'insufficientFunds'
  | 'belowMinAda'

/** A validated recipient ready to become a tx output. */
export type ResolvedTarget = {
  readonly addressHex: AddressHex
  readonly amounts: ReadonlyMap<string, bigint>
  /**
   * An inline datum on this output — the data a script reads when the UTxO is later spent.
   *
   * Never set by the send funnel, which has no screen for one. It is here because a `ResolvedTarget`
   * *is* one plan output, and the builders that publish a reference script need somewhere to say so
   * without a second output type that would have to be kept in step with this one.
   */
  readonly datumHex?: string
  /** A reference script carried by this output, CBOR `[version, script]` hex. As above. */
  readonly scriptRefHex?: string
}

export type SendValidation =
  | {readonly ok: true; readonly targets: readonly ResolvedTarget[]; readonly memo: string}
  | {
      readonly ok: false
      readonly error: SendValidationError
      readonly targetIndex?: number
      /** For `belowMinAda`: the lovelace this output actually needs, so the UI can say so. */
      readonly requiredMinAda?: bigint
    }

export const emptyTarget = (): SendTarget => ({
  address: '',
  resolvedAddressHex: null,
  resolvedMidnightAddress: null,
  resolvedName: null,
  amounts: new Map([[ADA_ID, 0n]]),
  sendAll: new Set(),
})

export const initialSendState = (): SendState => ({
  targets: [emptyTarget()],
  memo: '',
  rail: CARDANO_RAIL,
  sources: [],
})

/** True when this target has an address the send can actually pay, on the state's rail. */
export const isTargetResolved = (target: SendTarget, rail: SendRail): boolean =>
  rail.chain === 'cardano' ? target.resolvedAddressHex !== null : target.resolvedMidnightAddress !== null

/**
 * Move the funnel onto a rail, dropping what the new one cannot express.
 *
 * Midnight pays **one** recipient from **one** wallet, so extra targets and every co-funding source
 * go — silently keeping them would leave the review to discover recipients the screen had stopped
 * showing. The ADA row goes with them: `ADA_ID → 0n` is Cardano's idea of "nothing chosen yet" and
 * means nothing on Midnight, where the asset arrives with the rail.
 */
export const setSendRail = (state: SendState, rail: SendRail): SendState => {
  if (rail.chain === 'cardano' && state.rail.chain === 'cardano') return state
  if (rail.chain === 'midnight' && state.rail.chain === 'midnight' && rail.rail === state.rail.rail) return state
  if (rail.chain === 'cardano') {
    return {
      ...state,
      rail,
      targets: state.targets.map((t) => ({
        ...t,
        resolvedMidnightAddress: null,
        amounts: t.amounts.has(ADA_ID) ? t.amounts : new Map([[ADA_ID, 0n], ...t.amounts]),
      })),
    }
  }
  const first = state.targets[0]
  return {
    ...state,
    rail,
    sources: [],
    targets: [
      first === undefined
        ? emptyTarget()
        : {...first, resolvedAddressHex: null, resolvedName: null, amounts: new Map(), sendAll: new Set()},
    ],
  }
}

/**
 * A send seeded from a payment request — a scanned QR, a deep link, a card in a
 * message.
 *
 * Applied to the *first* target only, and only when nothing has been typed yet.
 * A prefill arriving mid-compose would overwrite a recipient the user chose, and
 * the direction of that mistake is the dangerous one: money to an address they
 * did not pick. Whatever is already there wins.
 *
 * The address is seeded raw and left unresolved on purpose. Resolution is the
 * screen's job and it validates — a prefill that also claimed
 * `resolvedAddressHex` would be a link asserting its own address is valid.
 */
export const withPrefill = (
  state: SendState,
  prefill: {readonly address: string; readonly lovelace: bigint | null},
): SendState => {
  const first = state.targets[0]
  if (first === undefined || first.address.trim() !== '') return state
  const amounts = prefill.lovelace === null ? first.amounts : new Map([...first.amounts, [ADA_ID, prefill.lovelace]])
  return {...state, targets: [{...first, address: prefill.address, amounts}, ...state.targets.slice(1)]}
}

const replaceTarget = (state: SendState, index: number, patch: (t: SendTarget) => SendTarget): SendState => ({
  ...state,
  targets: state.targets.map((t, i) => (i === index ? patch(t) : t)),
})

export const addTarget = (state: SendState): SendState =>
  state.targets.length >= maxTargetsFor(state.rail) ? state : {...state, targets: [...state.targets, emptyTarget()]}

export const removeTarget = (state: SendState, index: number): SendState =>
  state.targets.length <= 1 ? state : {...state, targets: state.targets.filter((_, i) => i !== index)}

/** Set a recipient's raw input; clears any prior resolution (must re-resolve). */
export const setTargetAddress = (state: SendState, index: number, address: string): SendState =>
  replaceTarget(state, index, (t) => ({
    ...t,
    address,
    resolvedAddressHex: null,
    resolvedMidnightAddress: null,
    resolvedName: null,
  }))

/** Record a validated Midnight recipient. The rail is set alongside by {@link setSendRail}. */
export const setTargetMidnightResolution = (state: SendState, index: number, address: string | null): SendState =>
  replaceTarget(state, index, (t) => ({...t, resolvedMidnightAddress: address}))

export const setTargetResolution = (
  state: SendState,
  index: number,
  resolvedAddressHex: string | null,
  resolvedName: string | null,
): SendState => replaceTarget(state, index, (t) => ({...t, resolvedAddressHex, resolvedName}))

export const addTargetToken = (state: SendState, index: number, assetId: string): SendState =>
  replaceTarget(state, index, (t) =>
    t.amounts.has(assetId) ? t : {...t, amounts: new Map([...t.amounts, [assetId, 0n]])},
  )

export const removeTargetToken = (state: SendState, index: number, assetId: string): SendState =>
  replaceTarget(state, index, (t) => {
    if (assetId === ADA_ID) return t // ADA row is not removable
    const amounts = new Map(t.amounts)
    amounts.delete(assetId)
    const sendAll = new Set(t.sendAll)
    sendAll.delete(assetId)
    return {...t, amounts, sendAll}
  })

export const setTargetAmount = (state: SendState, index: number, assetId: string, quantity: bigint): SendState =>
  replaceTarget(state, index, (t) => {
    const sendAll = new Set(t.sendAll)
    sendAll.delete(assetId) // typing an amount clears send-all for that asset
    return {...t, amounts: new Map([...t.amounts, [assetId, quantity]]), sendAll}
  })

/**
 * The amount, as the *only* thing this target pays.
 *
 * ⚠️ **Midnight's rail, and only its.** A Midnight transfer is one recipient, one token, one amount —
 * `validateMidnightSend` refuses a target carrying two positive figures — so a user who picks one
 * token, goes back, and picks another must not leave the first behind. {@link setTargetAmount} merges,
 * which is right for Cardano's basket and wrong here.
 */
export const setSoleTargetAmount = (state: SendState, index: number, assetId: string, quantity: bigint): SendState =>
  replaceTarget(state, index, (t) => ({...t, amounts: new Map([[assetId, quantity]]), sendAll: new Set()}))

export const setTargetSendAll = (state: SendState, index: number, assetId: string, on: boolean): SendState =>
  replaceTarget(state, index, (t) => {
    const sendAll = new Set(t.sendAll)
    if (on) sendAll.add(assetId)
    else sendAll.delete(assetId)
    return {...t, sendAll, amounts: t.amounts.has(assetId) ? t.amounts : new Map([...t.amounts, [assetId, 0n]])}
  })

export const setMemo = (state: SendState, memo: string): SendState => ({...state, memo})

/**
 * Hub-level chosen assets/amounts — what to send, before it is attributed to a
 * recipient. With a single recipient the basket IS that recipient's amounts
 * ({@link applyBasketToSingleTarget}); with several the allocate step
 * distributes it into per-target amounts.
 */
export type SendBasket = {
  /** assetId → total quantity to send (base units). */
  readonly amounts: ReadonlyMap<string, bigint>
  /** assetIds flagged "send all" — single-recipient only (build resolves the amount). */
  readonly sendAll: ReadonlySet<string>
}

export const emptyBasket = (): SendBasket => ({amounts: new Map([[ADA_ID, 0n]]), sendAll: new Set()})

export const basketAddToken = (basket: SendBasket, assetId: string): SendBasket =>
  basket.amounts.has(assetId) ? basket : {...basket, amounts: new Map([...basket.amounts, [assetId, 0n]])}

export const basketRemoveToken = (basket: SendBasket, assetId: string): SendBasket => {
  if (assetId === ADA_ID) return basket // ADA row is not removable
  const amounts = new Map(basket.amounts)
  amounts.delete(assetId)
  const sendAll = new Set(basket.sendAll)
  sendAll.delete(assetId)
  return {amounts, sendAll}
}

export const basketSetAmount = (basket: SendBasket, assetId: string, quantity: bigint): SendBasket => {
  const sendAll = new Set(basket.sendAll)
  sendAll.delete(assetId) // typing an amount clears send-all for that asset
  return {amounts: new Map([...basket.amounts, [assetId, quantity]]), sendAll}
}

export const basketToggleSendAll = (basket: SendBasket, assetId: string, on: boolean): SendBasket => {
  const sendAll = new Set(basket.sendAll)
  if (on) sendAll.add(assetId)
  else sendAll.delete(assetId)
  return {
    sendAll,
    amounts: basket.amounts.has(assetId) ? basket.amounts : new Map([...basket.amounts, [assetId, 0n]]),
  }
}

/** Drop all send-all flags — required before allocating across several recipients. */
export const clearBasketSendAll = (basket: SendBasket): SendBasket => ({...basket, sendAll: new Set()})

/** Write the basket onto the sole recipient (single-recipient review path). */
export const applyBasketToSingleTarget = (state: SendState, basket: SendBasket): SendState =>
  replaceTarget(state, 0, (t) => ({...t, amounts: new Map(basket.amounts), sendAll: new Set(basket.sendAll)}))

/** Basket quantity of `assetId` not yet attributed to any recipient. Never negative. */
/**
 * How much of an asset is still unallocated — **signed**, so over-allocation is visible.
 *
 * It used to clamp at zero, which made "exactly allocated" and "allocated 20 too much"
 * render as the same green `0 left`: the screen said the split was done while Review sat
 * disabled with nothing explaining why. A negative result is the overshoot, and the caller
 * has to say so rather than hide it.
 */
export const allocationRemaining = (basket: SendBasket, targets: readonly SendTarget[], assetId: string): bigint => {
  let allocated = 0n
  for (const t of targets) allocated += t.amounts.get(assetId) ?? 0n
  return (basket.amounts.get(assetId) ?? 0n) - allocated
}

/** True when every positive basket amount is exactly attributed across the targets. */
export const basketFullyAllocated = (basket: SendBasket, targets: readonly SendTarget[]): boolean => {
  for (const [assetId, total] of basket.amounts) {
    if (total === 0n) continue
    let allocated = 0n
    for (const t of targets) allocated += t.amounts.get(assetId) ?? 0n
    if (allocated !== total) return false
  }
  return true
}

/** What other targets commit for `assetId`, and whether one claims send-all. */
const committedByOthers = (
  assetId: string,
  targetIndex: number,
  targets: readonly SendTarget[],
): {readonly explicit: bigint; readonly someoneSendAll: boolean} => {
  let explicit = 0n
  let someoneSendAll = false
  targets.forEach((t, i) => {
    if (i === targetIndex) return
    if (t.sendAll.has(assetId)) someoneSendAll = true
    else explicit += t.amounts.get(assetId) ?? 0n
  })
  return {explicit, someoneSendAll}
}

/**
 * Balance of `assetId` still available to `targetIndex` after other targets'
 * commitments. Zero if another target claims send-all of it. Never negative.
 */
export const availableForTarget = (
  assetId: string,
  targetIndex: number,
  balance: ReadonlyMap<string, bigint>,
  targets: readonly SendTarget[],
): bigint => {
  const {explicit, someoneSendAll} = committedByOthers(assetId, targetIndex, targets)
  if (someoneSendAll) return 0n
  const remaining = (balance.get(assetId) ?? 0n) - explicit
  return remaining > 0n ? remaining : 0n
}

/**
 * Validate + resolve a send. `adaFeeReserve` is subtracted from an ADA send-all
 * (a fee cushion; the build layer's fee-aware pass tightens it).
 *
 * `minAdaFor` returns the ledger's floor for one resolved output — it depends on
 * what the output contains, so it cannot be a constant. `null` means the floor is
 * unknown (no codec or no params yet), and an unknown floor must not block a send:
 * the build stays authoritative, exactly as before this check existed.
 */
/** A validated Midnight send: one recipient, one asset, one amount. */
export type MidnightSendValidation =
  | {readonly ok: true; readonly address: string; readonly assetId: string; readonly amount: bigint}
  | {readonly ok: false; readonly error: SendValidationError}

/**
 * Validate the Midnight rail's send.
 *
 * Separate from {@link validateSend} rather than a branch inside it, because the two produce
 * different things: a Cardano send resolves to `ResolvedTarget[]` keyed by address *bytes*, and a
 * Midnight recipient is a bech32 string that never becomes one. Nothing here has a min-ada floor, a
 * fee reserve or a cross-target allocation — a transfer is one output and somebody else pays.
 *
 * `available` is `null` when the rail cannot report a balance (the shielded rail's holdings come
 * from the coin core, which may not have synced). That skips the funds check rather than comparing
 * against a zero we do not know to be true — the chain refuses an overspend either way, and a
 * fabricated "insufficient" would block a send that is actually fine.
 */
export const validateMidnightSend = (state: SendState, available: bigint | null): MidnightSendValidation => {
  const target = state.targets[0]
  if (target === undefined) return {ok: false, error: 'noRecipients'}
  if (target.resolvedMidnightAddress === null) return {ok: false, error: 'unresolvedAddress'}

  const positive = [...target.amounts].filter(([, qty]) => qty > 0n)
  const entry = positive[0]
  if (entry === undefined) return {ok: false, error: 'noAssets'}
  if (positive.length > 1) return {ok: false, error: 'invalidAmount'}

  const [assetId, amount] = entry
  if (available !== null && amount > available) return {ok: false, error: 'insufficientFunds'}
  return {ok: true, address: target.resolvedMidnightAddress, assetId, amount}
}

export const validateSend = (
  state: SendState,
  balance: ReadonlyMap<string, bigint>,
  opts: {
    readonly adaFeeReserve: bigint
    readonly minAdaFor: (target: ResolvedTarget) => bigint | null
  },
): SendValidation => {
  if (state.targets.length === 0) return {ok: false, error: 'noRecipients'}

  const resolved: ResolvedTarget[] = []
  for (let index = 0; index < state.targets.length; index++) {
    const target = state.targets[index]
    if (target === undefined) continue
    if (target.resolvedAddressHex === null) return {ok: false, error: 'unresolvedAddress', targetIndex: index}

    const amounts = new Map<string, bigint>()
    for (const [assetId, typed] of target.amounts) {
      const isSendAll = target.sendAll.has(assetId)
      let qty = isSendAll ? availableForTarget(assetId, index, balance, state.targets) : typed
      if (isSendAll && assetId === ADA_ID) qty = qty > opts.adaFeeReserve ? qty - opts.adaFeeReserve : 0n
      if (qty < 0n) return {ok: false, error: 'invalidAmount', targetIndex: index}
      if (qty > 0n) amounts.set(assetId, qty)
    }

    if (amounts.size === 0) return {ok: false, error: 'noAssets', targetIndex: index}

    // Every output has a floor, not just token-bearing ones: a plain 0.5 ADA send
    // is rejected by the ledger too, and used to fail at build rather than here.
    const candidate: ResolvedTarget = {addressHex: AddressHex(target.resolvedAddressHex), amounts}
    const floor = opts.minAdaFor(candidate)
    const statedAda = amounts.get(ADA_ID) ?? 0n
    if (statedAda === 0n) {
      /**
       * ⚠️ **A token-only output is completed, not refused.**
       *
       * A Cardano output must carry ADA, so "send all of this token" is impossible to honour without
       * some — but the user did not ask to send ADA, they asked to send the token, and the ledger's
       * floor is the answer to "how much does that take". Demanding they discover the figure and type
       * it was the old behaviour, and the message could not even name it: this branch returned before
       * the floor was computed.
       *
       * The distinction the rest of this block keeps is between an amount *stated* below the floor —
       * refused, with the floor named, because raising it would move more ADA than they asked for —
       * and one not stated at all, which means "whatever this output needs".
       */
      if (floor === null) return {ok: false, error: 'belowMinAda', targetIndex: index}
      amounts.set(ADA_ID, floor)
    } else if (floor !== null && statedAda < floor) {
      return {ok: false, error: 'belowMinAda', targetIndex: index, requiredMinAda: floor}
    }
    resolved.push(candidate)
  }

  // Aggregate demand per asset must fit the balance (ADA fee is checked at build).
  const demand = new Map<string, bigint>()
  for (const t of resolved) for (const [id, q] of t.amounts) demand.set(id, (demand.get(id) ?? 0n) + q)
  for (const [id, want] of demand) {
    if (want > (balance.get(id) ?? 0n)) return {ok: false, error: 'insufficientFunds'}
  }

  return {ok: true, targets: resolved, memo: state.memo}
}
