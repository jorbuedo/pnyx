/**
 * What a Midnight transaction *contains*, read from the transaction — not from what its caller said.
 *
 * The review today renders the request: `MidnightReviewScreen` builds from ticket and URL params
 * because at that point there is no transaction to read. For a wallet-composed send that is thin; for
 * a dApp's or an agent's `makeTransfer` it is **the caller's own claim shown back to the person as
 * though the wallet had checked it**. `docs/MIDNIGHT_REVIEW_FROM_BYTES.md` has the full argument.
 *
 * This is the first half of the fix: bytes → facts. The wallet-aware half — what *this* wallet gains
 * and loses — is `./midnight-effect.ts`, kept separate because it needs keys and addresses and this
 * needs nothing.
 *
 * ## ⚠️ Shielded is partial by construction, and that must survive into the IR
 *
 * An unshielded offer states its inputs and outputs in the clear: colour, value, owner. A **shielded**
 * (Zswap) offer does not — amounts and recipients are encrypted, and a reader with no key can see only
 * that value moves and how many outputs carry it. `chain-client`'s own decoder says the same thing:
 * *"a zswap offer is value moving even though this host cannot see whose."*
 *
 * So {@link MidnightTxFacts} reports shielded parts as **counts, never as amounts**, and
 * `./midnight-effect.ts` fills in only the outputs the wallet can decrypt. A review that rendered a
 * shielded transfer as though it knew the figures would be inventing them.
 *
 * ## ⚠️ Takes a deserialized transaction, not bytes
 *
 * Deserializing needs the ledger wasm, which this package must not pull in — the app already holds a
 * deserializer and the sponsor path already passes one around. So the caller deserializes and this
 * reads the shape, which is also what makes every rule below testable against a plain object.
 *
 * ⚠️ **`packages/chain-client/src/sponsorship.ts` reads the same bytes for a different purpose** (the
 * sponsorship policy, not a person's review) and cannot be shared: the app does not depend on
 * `chain-client`, and adding the edge to pull two readers together would drag a headless wallet client
 * into the review path. They are deliberately parallel; the field names here match that file's so the
 * two stay legible side by side. A real-bytes cross-check between them is a follow-up.
 *
 * @module
 */

/** One unshielded UTXO an offer names. Field names match `chain-client`'s `OfferedUtxo`. */
export type MidnightUtxoFact = {
  /** The token type, hex, lowercased. `''` when it could not be read. */
  readonly colour: string
  readonly value: bigint
  /** The address that owns it, lowercased. `''` when it could not be read. */
  readonly owner: string
}

/** What one intent moves, per segment. Segment ids matter: balancing is per segment. */
export type MidnightIntentFact = {
  readonly segment: number
  /**
   * Absolute expiry, unix seconds, or `null` where the reader could not state one.
   *
   * ⚠️ `null` is "not read", never "does not expire". Every contributor to a co-funded intent signs
   * over this value, so it is part of what a review has to show — and a review that rendered an
   * unknown expiry as "no expiry" would say the opposite of the truth.
   */
  readonly ttlSecs: number | null
  /** The guaranteed section — fees are taken here, so it runs first. */
  readonly guaranteed: {readonly inputs: readonly MidnightUtxoFact[]; readonly outputs: readonly MidnightUtxoFact[]}
  /** The fallible section, rolled back atomically if it fails. NIGHT inputs live here. */
  readonly fallible: {readonly inputs: readonly MidnightUtxoFact[]; readonly outputs: readonly MidnightUtxoFact[]}
  readonly calls: readonly {readonly address: string; readonly entryPoint: string}[]
  readonly deploys: readonly {readonly address: string}[]
  /** Anything neither a call nor a deploy — counted, never dropped. */
  readonly otherActions: number
}

export type MidnightTxFacts = {
  /**
   * The network the transaction names, or `''` where the reader could not state one.
   *
   * ⚠️ `''` is "not read", never "any network". Only the native reader can answer it — the ledger's
   * JS bindings expose no accessor for a transaction's network id — so a consumer must treat the
   * empty string as *no claim* and never as a mismatch. Saying nothing is right; inventing a match is
   * not.
   */
  readonly networkId: string
  readonly intents: readonly MidnightIntentFact[]
  /**
   * Shielded outputs, **counted only** — their amounts and recipients are encrypted.
   *
   * `0` means no shielded offer rode along. A non-zero count with no amounts is the honest statement
   * of a shielded transfer seen without the key.
   */
  readonly shieldedOutputs: number
  /** True when a shielded offer is present at all, including one whose outputs could not be counted. */
  readonly hasShielded: boolean
  /**
   * False when the transaction was not the shape this reader understands — not a standard transaction,
   * or an intent map it could not walk.
   *
   * ⚠️ Load-bearing, exactly as Cardano's `understood` is: a caller must be able to say "the effect
   * cannot be determined" instead of rendering the empty facts as "this transaction does nothing".
   */
  readonly understood: boolean
}

type Side = {inputs?: unknown[]; outputs?: unknown[]} | undefined

const utxosOf = (offer: Side, side: 'inputs' | 'outputs'): MidnightUtxoFact[] => {
  const entries = side === 'inputs' ? offer?.inputs : offer?.outputs
  if (!Array.isArray(entries)) return []
  return entries.map((entry) => {
    const utxo = entry as {type?: unknown; value?: unknown; owner?: unknown}
    return {
      // Kept with an empty colour and a zero value rather than dropped: an entry we cannot read is
      // still an entry, and losing it would make a transaction look smaller than it is.
      colour: typeof utxo.type === 'string' ? utxo.type.toLowerCase() : '',
      value: typeof utxo.value === 'bigint' || typeof utxo.value === 'number' ? BigInt(utxo.value) : 0n,
      owner: typeof utxo.owner === 'string' ? utxo.owner.toLowerCase() : '',
    }
  })
}

const sectionOf = (offer: unknown) => ({
  inputs: utxosOf(offer as Side, 'inputs'),
  outputs: utxosOf(offer as Side, 'outputs'),
})

/**
 * An intent's expiry in unix seconds.
 *
 * The bindings type `Intent.ttl` as a `Date`; a number or bigint is accepted because the same field
 * crosses the native wire as seconds. Anything else is `null` — an expiry we cannot state, which a
 * review must render as unknown rather than as "no expiry".
 */
const ttlSecondsOf = (ttl: unknown): number | null => {
  if (ttl instanceof Date) {
    const secs = Math.floor(ttl.getTime() / 1000)
    return Number.isFinite(secs) ? secs : null
  }
  if (typeof ttl === 'bigint') return Number(ttl)
  if (typeof ttl === 'number' && Number.isFinite(ttl)) return Math.floor(ttl)
  return null
}

const nameOf = (entryPoint: unknown): string =>
  typeof entryPoint === 'string' ? entryPoint : (((entryPoint as {value?: unknown} | undefined)?.value as string) ?? '')

/**
 * Read a deserialized Midnight transaction.
 *
 * Never throws: an unreadable transaction comes back `understood: false` with whatever was legible,
 * because a review that crashes tells the person less than one that says it could not tell.
 */
export const readMidnightTxFacts = (transaction: unknown): MidnightTxFacts => {
  const tx = transaction as
    | {
        intents?: unknown
        networkId?: unknown
        guaranteedOffer?: {outputs?: unknown[]} | undefined
        fallibleOffer?: {size?: number; outputs?: unknown[]} | undefined
      }
    | null
    | undefined
  const empty: MidnightTxFacts = {
    networkId: '',
    intents: [],
    shieldedOutputs: 0,
    hasShielded: false,
    understood: false,
  }
  if (tx === null || tx === undefined) return empty
  // The bindings expose no accessor for this, so it is normally absent — `''` says so rather than
  // letting a consumer read a missing network as a matching one.
  const networkId = typeof tx.networkId === 'string' ? tx.networkId : ''

  const shieldedOffers = [tx.guaranteedOffer, tx.fallibleOffer].filter((one) => one !== undefined)
  const hasShielded = shieldedOffers.length > 0 || (tx.fallibleOffer?.size ?? 0) > 0
  const shieldedOutputs = shieldedOffers.reduce(
    (total, offer) => total + (Array.isArray(offer?.outputs) ? offer.outputs.length : 0),
    0,
  )

  const raw = tx.intents
  // A Map is what the ledger gives; anything else is a shape this reader does not know. Reported as
  // not understood rather than as an absence of intents.
  if (!(raw instanceof Map)) {
    return {networkId, intents: [], shieldedOutputs, hasShielded, understood: false}
  }

  const intents: MidnightIntentFact[] = []
  for (const [key, value] of raw.entries()) {
    // An intent that is not an object is counted as present and unreadable rather than skipped: a
    // segment that vanished would make the transaction look like it touches fewer places than it does.
    const intent = (typeof value === 'object' && value !== null ? value : {}) as {
      actions?: unknown
      ttl?: unknown
      guaranteedUnshieldedOffer?: unknown
      fallibleUnshieldedOffer?: unknown
    }
    const calls: {address: string; entryPoint: string}[] = []
    const deploys: {address: string}[] = []
    let otherActions = 0
    for (const action of Array.isArray(intent.actions) ? intent.actions : []) {
      const candidate = action as {address?: unknown; entryPoint?: unknown; initialState?: unknown}
      if (typeof candidate.address !== 'string') {
        otherActions += 1
        continue
      }
      if (candidate.entryPoint !== undefined) {
        calls.push({address: candidate.address, entryPoint: nameOf(candidate.entryPoint)})
        continue
      }
      if (candidate.initialState !== undefined) {
        deploys.push({address: candidate.address})
        continue
      }
      otherActions += 1
    }
    intents.push({
      segment: typeof key === 'number' ? key : Number(key),
      ttlSecs: ttlSecondsOf(intent.ttl),
      guaranteed: sectionOf(intent.guaranteedUnshieldedOffer),
      fallible: sectionOf(intent.fallibleUnshieldedOffer),
      calls,
      deploys,
      otherActions,
    })
  }
  // Ascending, because a segment id is not decorative — it is what a deficit can be funded from.
  return {
    networkId,
    intents: [...intents].sort((a, b) => a.segment - b.segment),
    shieldedOutputs,
    hasShielded,
    understood: true,
  }
}

/** Every unshielded UTXO the transaction names, both sections of every intent. */
export const allUnshielded = (
  facts: MidnightTxFacts,
): {
  readonly inputs: readonly MidnightUtxoFact[]
  readonly outputs: readonly MidnightUtxoFact[]
} => ({
  inputs: facts.intents.flatMap((intent) => [...intent.guaranteed.inputs, ...intent.fallible.inputs]),
  outputs: facts.intents.flatMap((intent) => [...intent.guaranteed.outputs, ...intent.fallible.outputs]),
})
