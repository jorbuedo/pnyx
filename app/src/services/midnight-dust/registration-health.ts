/**
 * Pure registration-health decision core for the cNIGHT→DUST mapping (Proposal 0018).
 *
 * The mapping validator does not enforce single-registration on-chain — the uniqueness
 * design was dropped as too costly — and the observability layer treats a multiply-
 * registered key as **unregistered**. So holding the invariant is the wallet's job, and
 * this is the layer that *explains* every deviation instead of silently showing zero DUST.
 *
 * Keyed by the Cardano **stake key hash** (the datum's `c_wallet`, established by decoding
 * a real register transaction): registration is one-per-account, and all of the account's
 * cNIGHT shares that stake key. The shipped datum has **no `active` flag** — a registration
 * UTxO's presence *is* the registration — so there is no inactive state to reactivate.
 *
 * **The DUST destination is a choice, not a property of this wallet.** A NIGHT holder may
 * designate any recipient, including one they do not control — that is the documented hook
 * for delegation and fee sponsorship. So a registration pointing somewhere other than this
 * wallet's own address is *not* a fault to repair; it is reported, and changing it is an
 * action the user takes deliberately. An earlier cut flagged it as `StaleDustAddr`, which
 * would have nagged every delegating user to "fix" a registration that was exactly right.
 *
 * Every outcome carries a `surfaceKey`. Never a silent state: the whole point is that a
 * user who sees no DUST is told which of the several very different reasons applies.
 *
 * Decision order:
 *
 * | regs | further condition                              | state           | action                 |
 * |------|------------------------------------------------|-----------------|------------------------|
 * | 0    | —                                              | Unregistered    | register               |
 * | >1   | —                                              | MultiRegistered | repairMultiRegistration|
 * | 1    | DUST accruing                                  | HealthyActive   | none                   |
 * | 1    | eligibleNight > 0                              | HealthyActive   | none (starting)        |
 * | 1    | eligibleNight = 0, holds cNIGHT                | NoGeneration    | activateExistingCnight |
 * | 1    | eligibleNight = 0, no cNIGHT                   | NoGeneration    | none (zeroBalance)     |
 * | 1    | no cNIGHT at all                               | NoGeneration    | none (zeroBalance)     |
 * | 1    | no cNIGHT generates (see below)                | NoGeneration    | activateExistingCnight |
 * | 1    | within lag window, or no cursor to compare      | HealthyActive   | none (catching up)     |
 * | 1    | past lag                                       | NoGeneration    | none (observabilityLag)|
 *
 * When the indexer reports `eligibleNight` those rows apply and the lag heuristic is
 * skipped. The two rows after them need no Midnight data at all — holding no NIGHT, or only
 * NIGHT that predates the registration, settles the question from Cardano alone, so they are
 * decided *before* the observability gate rather than after it. Deciding them after meant
 * that with no observability reader wired (the current state) every registered wallet read as
 * "starting" and the activation surface was unreachable.
 *
 * "Generates" is {@link generatesDust}: produced by a transaction posterior to the
 * registration — which the registration's own change is not, however much NIGHT it carries.
 * The `activateExistingCnight` rows additionally require every cNIGHT UTxO to be *dated*: an
 * undated one leaves the diagnosis unproven, and this recommends no fee-bearing remedy on an
 * unproven diagnosis.
 *
 * No IO — the readers and the transaction builder sit on top.
 *
 * @module
 */

/** Cardano stake key hash (hex, 28 bytes) — the datum's `c_wallet`, the registration identity. */
export type StakeKeyHash = string
/** Raw DUST address payload (hex, ≤ 33 bytes) — the bytes inside an `mn_dust` bech32m address. */
export type DustAddrPayload = string
/** Cardano absolute slot. */
export type Slot = number
export type TxIn = {readonly txHash: string; readonly index: number}

/** A registration UTxO at the mapping validator, already filtered to this account. */
export type RegistrationUtxo = {
  readonly owner: StakeKeyHash
  /**
   * The designated DUST destination, or `undefined` when it could not be read — surfaced
   * as unverified rather than fabricated, since a guess would read as a mismatch and
   * prompt a fee-bearing repair of a healthy registration.
   */
  readonly dustAddr: DustAddrPayload | undefined
  readonly txSlot: Slot
  readonly ref: TxIn
  /**
   * The UTxO's own value, as CBOR hex. Spending a registration — to change its destination
   * or to remove it — makes it a mandatory input, and the balancer cannot account for the
   * auth token without knowing the value that carries it. Absent when the registering
   * transaction's bytes could not be read, which is exactly when the spend must not be
   * offered rather than attempted with a guessed value.
   */
  readonly valueHex?: string
}

/**
 * A cNIGHT-bearing UTxO in the account, with the slot it arrived — `null` when the creating
 * transaction is outside the scanned history and its arrival is genuinely unknown.
 */
export type CnightUtxo = {readonly ref: TxIn; readonly receiptSlot: Slot | null; readonly value: bigint}

/**
 * DUST/observability snapshot from the Midnight side. `cursorSlot` is the last Cardano slot
 * the observation pipeline processed, which is what lets lag be told from broken.
 */
export type ObservedDust = {
  readonly accruing: boolean
  /**
   * Last Cardano slot the observation pipeline processed, or `null` when the source exposes
   * no such cursor (the v4 indexer does not). `null` disables the lag comparison rather than
   * running it against a number nobody measured.
   */
  readonly cursorSlot: Slot | null
  /**
   * Eligible (post-registration) NIGHT per the indexer. When present it is used
   * authoritatively and no lag guessing happens.
   */
  readonly eligibleNight?: bigint
}

export type RegistrationState = 'Unregistered' | 'HealthyActive' | 'NoGeneration' | 'MultiRegistered'

export type NoGenCause = 'predatesRegistration' | 'observabilityLag' | 'zeroBalance'

/**
 * What the wallet should do *without being asked*. Changing the destination and
 * deregistering are deliberate user choices and never appear here — only a genuine
 * problem, or the one thing a user cannot be expected to know (that pre-registration NIGHT
 * has to be re-received).
 */
export type RegistrationAction =
  | {readonly kind: 'none'}
  | {readonly kind: 'register'}
  | {readonly kind: 'repairMultiRegistration'; readonly keep: TxIn; readonly remove: readonly TxIn[]}
  | {readonly kind: 'activateExistingCnight'; readonly utxos: readonly TxIn[]}

export type RegistrationAssessment = {
  readonly state: RegistrationState
  readonly noGenCause?: NoGenCause
  readonly action: RegistrationAction
  /**
   * i18n key under `midnightDust.status.*` for what to tell the user. Always set — a state
   * with nothing to say is the failure mode this module exists to prevent. A key rather
   * than a sentence so the core stays free of English.
   */
  readonly surfaceKey: string
}

export type AssessRegistrationInput = {
  /** Registration UTxOs at the mapping validator, already filtered to this account. */
  readonly regs: readonly RegistrationUtxo[]
  readonly cnight: readonly CnightUtxo[]
  readonly observedDust: ObservedDust | null
  /** Grace period, in slots, after registration before "no DUST" counts as a problem. */
  readonly lagWindow: Slot
}

const sameRef = (a: TxIn, b: TxIn): boolean => a.txHash === b.txHash && a.index === b.index

/**
 * Whether a cNIGHT UTxO generates DUST under `reg`: it must have been produced by a
 * transaction *posterior to* the registration.
 *
 * The tx-hash test is not redundant with the slot test. The registration's own change
 * carries whatever NIGHT its coin selection pulled in, and that change shares the
 * registration's slot — but it is an output of the registration, not a later receipt,
 * so it does not generate. Excluding the registration's hash is what separates it from
 * a chained self-send, which is posterior yet can land in the very same block.
 */
export const generatesDust = (c: CnightUtxo, reg: RegistrationUtxo): boolean =>
  c.receiptSlot !== null && c.ref.txHash !== reg.ref.txHash && c.receiptSlot >= reg.txSlot

/**
 * Which registration to keep when repairing a multi-registration: the most recent, as the
 * latest destination the user expressed. Preferring one that points at this wallet would
 * quietly overrule a deliberate delegation.
 */
const pickKeep = (regs: readonly RegistrationUtxo[]): RegistrationUtxo =>
  regs.reduce((best, r) => (r.txSlot > best.txSlot ? r : best))

/** Assess registration health and name the action that moves the account toward the invariant. */
export const assessRegistration = (input: AssessRegistrationInput): RegistrationAssessment => {
  if (input.regs.length === 0) {
    return {state: 'Unregistered', action: {kind: 'register'}, surfaceKey: 'unregistered'}
  }

  if (input.regs.length > 1) {
    const keep = pickKeep(input.regs)
    return {
      state: 'MultiRegistered',
      action: {
        kind: 'repairMultiRegistration',
        keep: keep.ref,
        remove: input.regs.filter((r) => !sameRef(r.ref, keep.ref)).map((r) => r.ref),
      },
      surfaceKey: 'multiRegistered',
    }
  }

  const reg = input.regs[0] as RegistrationUtxo
  const obs = input.observedDust
  if (obs?.accruing) {
    return {state: 'HealthyActive', action: {kind: 'none'}, surfaceKey: 'generating'}
  }

  // Indexer-authoritative: eligible NIGHT answers it directly, so skip the lag heuristic.
  if (obs !== null && obs.eligibleNight !== undefined) {
    if (obs.eligibleNight > 0n) {
      return {state: 'HealthyActive', action: {kind: 'none'}, surfaceKey: 'starting'}
    }
    if (input.cnight.length === 0) {
      return {state: 'NoGeneration', noGenCause: 'zeroBalance', action: {kind: 'none'}, surfaceKey: 'noCnight'}
    }
    return {
      state: 'NoGeneration',
      noGenCause: 'predatesRegistration',
      action: {kind: 'activateExistingCnight', utxos: input.cnight.map((c) => c.ref)},
      surfaceKey: 'predatesRegistration',
    }
  }

  // Provable from Cardano alone, so decided before the observability gate rather than after
  // it. Holding no NIGHT, or holding only NIGHT that predates the registration, means nothing
  // is generating no matter what the Midnight side reports or fails to report — and waiting
  // out a grace window for a fact already in hand just delays telling the user.
  if (input.cnight.length === 0) {
    return {state: 'NoGeneration', noGenCause: 'zeroBalance', action: {kind: 'none'}, surfaceKey: 'noCnight'}
  }
  // Only when every UTxO's arrival is *known* and none of them generates. An undated UTxO
  // makes this unprovable, and recommending a self-send on an unproven diagnosis charges a
  // fee to fix a wallet that may well be healthy.
  const allDated = input.cnight.every((c) => c.receiptSlot !== null)
  if (allDated && !input.cnight.some((c) => generatesDust(c, reg))) {
    return {
      state: 'NoGeneration',
      noGenCause: 'predatesRegistration',
      action: {kind: 'activateExistingCnight', utxos: input.cnight.map((c) => c.ref)},
      surfaceKey: 'predatesRegistration',
    }
  }

  // Eligible NIGHT is held, so the wallet's side is in order; only the Midnight side is
  // unconfirmed. Inside the grace window, or with no observability at all, that is catching
  // up rather than broken — recommending a fee-bearing repair here would be a guess.
  if (obs === null || obs.cursorSlot === null || obs.cursorSlot < reg.txSlot + input.lagWindow) {
    return {state: 'HealthyActive', action: {kind: 'none'}, surfaceKey: 'starting'}
  }
  // Eligible cNIGHT exists yet DUST is still not visible: nothing wallet-side to blame, so
  // report it as reconciliation rather than as a fault the user should act on.
  return {
    state: 'NoGeneration',
    noGenCause: 'observabilityLag',
    action: {kind: 'none'},
    surfaceKey: 'observabilityLag',
  }
}
