/**
 * How many UTxOs a wallet's NIGHT should be spread across, and how to get there by splitting change.
 *
 * ⚠️ **Why a wallet cares.** A DUST generation's rate *and* cap are proportional to the value of the
 * one NIGHT UTxO backing it (`cap = value × night_dust_ratio`), and a fee must be covered by a
 * **single** DUST output — `spend_for_fee` takes one, and reports rather than splitting. So a wallet
 * holding one large NIGHT UTxO has exactly **one** DUST output that can ever pay a fee, however much
 * DUST it holds in total. Measured on preprod 2026-08-23: *"no single DUST output covers a fee of
 * 686161378353573 across 26 held"* — 26 outputs, one usable.
 *
 * Spreading NIGHT across several UTxOs gives several generations, each with a cap of its own, so a fee
 * always has a payer. It also keeps any one output's spend history short, which is what the DUST sync's
 * repair walk costs a pass per link of.
 *
 * **Time to fill is unaffected.** Rate and cap are both proportional to the backing value, so N chunks
 * each reach their own cap in the same time one large output would. Total DUST at steady state is
 * unchanged too — this buys *distribution*, not more DUST.
 *
 * ⚠️ **Aim, never force.** A chunk whose cap cannot cover a fee is worse than no chunk: it fragments
 * the wallet without buying a payer. So the target is an aspiration bounded by
 * {@link NightSpreadPolicy.minChunkStars}, and a wallet with little NIGHT simply stays as it is.
 *
 * ⚠️ **The trap this module does not solve.** Spending a NIGHT UTxO sets its generation's `dtime`, and
 * its DUST then decays linearly to zero while the replacements start empty. So a rebalance forfeits the
 * DUST it was built on, and the transaction doing it still needs a fee. Never consume the backing NIGHT
 * of the only output that can currently pay — that check needs the DUST→NIGHT mapping, which is
 * `initial_nonce(output_no, intent_hash)` and therefore a hash only the native side can compute. It is
 * a separate piece of work; converging a few chunks at a time is what keeps this safe meanwhile.
 *
 * @module
 */

/** NIGHT's atomic unit. Mirrors the ledger's `STARS_PER_NIGHT`. */
export const STARS_PER_NIGHT = 1_000_000n

/** DUST's atomic unit. Mirrors the ledger's `SPECKS_PER_DUST`. */
export const SPECKS_PER_DUST = 1_000_000_000_000_000n

/**
 * SPECK of DUST capacity per STAR of backing NIGHT.
 *
 * The ledger sets `night_dust_ratio: 5 * (SPECKS_PER_DUST / STARS_PER_NIGHT)` — five DUST per NIGHT at
 * cap. Mirrored rather than read because it is a consensus parameter the node also publishes: if a
 * chain ever changes it, {@link dustCapForNight} is the one place that has to follow.
 */
export const NIGHT_DUST_RATIO = 5n * (SPECKS_PER_DUST / STARS_PER_NIGHT)

/** The DUST a NIGHT holding generates at full capacity, in SPECK. */
export const dustCapForNight = (stars: bigint): bigint => stars * NIGHT_DUST_RATIO

/**
 * The least NIGHT worth backing a generation with, given what a fee costs and how many of them a chunk
 * should be able to pay before it needs to refill.
 *
 * Derived rather than chosen: the useful size of a chunk is a function of the fee, and hard-coding a
 * figure would silently stop being right when fees move.
 */
export const minChunkForFees = (feeSpecks: bigint, fees: number): bigint => {
  if (feeSpecks <= 0n || fees <= 0) return 0n
  const needed = feeSpecks * BigInt(fees)
  // Round up: a chunk one STAR short of covering the fees asked for is not a chunk that covers them.
  return (needed + NIGHT_DUST_RATIO - 1n) / NIGHT_DUST_RATIO
}

export type NightSpreadPolicy = {
  /**
   * How many NIGHT UTxOs to aim for.
   *
   * Parametrizable because it is a property of the wallet's job, not of the chain: a sponsor funding
   * many users' transactions needs more simultaneous payers than a personal wallet does.
   */
  readonly targetUtxos: number
  /** Never create a chunk below this. See {@link minChunkForFees}. */
  readonly minChunkStars: bigint
  /** Most change outputs one transaction may carry, so a rebalance cannot bloat a send. */
  readonly maxChunksPerTx: number
}

/**
 * The default aim: 30 UTxOs, each able to cover ten fees at the figure measured on preprod
 * (686,161,378,353,573 SPECK — about 0.69 DUST), and at most 8 new chunks per transaction.
 *
 * Ten fees rather than one so a chunk stays useful while it refills, and because a chunk is rarely at
 * full cap. Eight per transaction so the spread converges over a handful of sends instead of putting
 * thirty outputs into one.
 */
export const DEFAULT_NIGHT_SPREAD: NightSpreadPolicy = {
  targetUtxos: 30,
  minChunkStars: minChunkForFees(686_161_378_353_573n, 10),
  maxChunksPerTx: 8,
}

/**
 * How to split a transaction's change so the wallet moves toward its target spread.
 *
 * Returns the value of each change output, largest first. Always at least one entry when there is
 * change to return, so a caller can use the result unconditionally.
 *
 * The remainder lands on the first chunk rather than being spread, so every output is a whole number of
 * STARS and the values sum to exactly `changeStars` — a split that lost a unit would burn it.
 */
export const planChangeSplit = (params: {
  /** The change this transaction returns, in STARS. */
  readonly changeStars: bigint
  /**
   * How many NIGHT UTxOs the wallet will hold after this transaction, **not counting** the change it
   * is about to return. Inputs consumed by this transaction are already excluded.
   */
  readonly utxosAfterExcludingChange: number
  readonly policy: NightSpreadPolicy
}): readonly bigint[] => {
  const {changeStars, utxosAfterExcludingChange, policy} = params
  if (changeStars <= 0n) return []

  // The change output itself is one of the UTxOs we want, so a wallet one short of target needs no
  // split at all.
  const wanted = policy.targetUtxos - utxosAfterExcludingChange
  if (wanted <= 1) return [changeStars]

  // How many chunks this change can afford at the minimum useful size. `0` when the change is below one
  // chunk, which is the case that must not fragment.
  const affordable = policy.minChunkStars <= 0n ? wanted : Number(changeStars / policy.minChunkStars)
  const chunks = Math.min(wanted, affordable, policy.maxChunksPerTx)
  if (chunks <= 1) return [changeStars]

  const n = BigInt(chunks)
  const base = changeStars / n
  const remainder = changeStars % n
  return [base + remainder, ...Array.from({length: chunks - 1}, () => base)]
}
