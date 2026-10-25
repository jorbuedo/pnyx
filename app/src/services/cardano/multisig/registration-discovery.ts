/**
 * Finding the shared wallets you are part of, from your seed alone.
 *
 * CIP-146's discovery is: derive your own `1854'/1815'/N'/x/y` credentials, find
 * label-1854 registrations whose scripts name them, and where a credential
 * appears in more than one, **the oldest wins**.
 *
 * **That rule is the anti-phishing mechanism, and it only works on a total view.**
 * A registration is public metadata that grants nobody anything — the script is
 * what controls funds — but a wallet that *displays* a discovered shared wallet is
 * vouching for it. On a partial index the earliest *visible* registration becomes
 * authoritative, and which ones you can see is the attacker's to choose. There is
 * a registration on mainnet today named "StealMulti"; the rule is what stops one
 * like it outranking a real wallet.
 *
 * A total view is affordable here because the set is tiny: `tx_by_metalabel`
 * returns every label-1854 transaction ever, which was 162 on mainnet and 61 on
 * preprod when this was written. It is fetched whole, not sampled, and
 * `_after_block_height` makes later runs incremental against a stored watermark.
 *
 * **This was believed impossible.** The note it replaces said Koios had no reverse
 * index for metadata labels. Koios has `tx_by_metalabel`, beside the
 * `tx_metalabels` endpoint that was read instead; the real gap was in our own
 * `Provider` port, and that got written down as a fact about the backend.
 *
 * Matching is pure and takes its rows as data, so the rule is testable without a
 * network — which matters more here than usual, because the failure mode is
 * showing somebody a wallet that is not theirs.
 *
 * @module
 */

import {Data, Effect} from 'effect'

/** The CIP-146 metadata label, as Koios keys it in `metadata`. */
export const CIP146_LABEL_KEY = '1854'

/** A native script as Koios serves it — JSON, not CBOR, so no codec is needed. */
export type ScriptJson = {
  readonly type?: string
  readonly keyHash?: string
  readonly scripts?: readonly ScriptJson[]
}

/** One label-1854 transaction, as much of it as matching needs. */
export type RegistrationRow = {
  readonly txHash: string
  readonly blockHeight: number
  /** Wallet name from the metadata. Absent when the publisher wrote none. */
  readonly name: string | undefined
  /** Every `keyHash` leaf across the transaction's native scripts. */
  readonly keyHashes: readonly string[]
  /**
   * The compiled script hashes. These are what identify the *wallet*, so a result
   * can be recognised as one already on this device — a discovery that repeats a
   * wallet sitting in the list below it is a worse answer than one that says so.
   */
  readonly scriptHashes: readonly string[]
  /** Participant labels, keyed by co-signer tag. */
  readonly participants: Readonly<Record<string, {readonly name?: string}>>
}

export type DiscoveredWallet = {
  readonly txHash: string
  readonly blockHeight: number
  readonly name: string | undefined
  /** Which of *our* credentials it names, so a caller can say why it matched. */
  readonly matched: readonly string[]
  readonly scriptHashes: readonly string[]
  readonly participants: Readonly<Record<string, {readonly name?: string}>>
}

/**
 * Every `keyHash` leaf in a native script, at any depth.
 *
 * Walks the JSON Koios serves rather than decoding the CBOR: the leaves are the
 * only thing matching needs, and decoding would pull in the codec layer to arrive
 * at the same list. Depth is bounded by the script itself, which the ledger caps.
 */
export const keyHashesOf = (script: ScriptJson | undefined): readonly string[] => {
  if (script === undefined || script === null) return []
  const here = typeof script.keyHash === 'string' && script.keyHash !== '' ? [script.keyHash.toLowerCase()] : []
  const nested = Array.isArray(script.scripts) ? script.scripts.flatMap((s) => keyHashesOf(s)) : []
  return [...here, ...nested]
}

/**
 * The registrations naming any of `ownKeyHashes`, **oldest first**.
 *
 * Ordering is the whole point rather than a presentation choice — see the module
 * note. Ties on block height are broken by transaction hash so the result is
 * deterministic; two registrations in one block is not a case the CIP resolves,
 * and picking arbitrarily-but-stably beats picking differently each run.
 */
export const matchRegistrations = (
  rows: readonly RegistrationRow[],
  ownKeyHashes: readonly string[],
): readonly DiscoveredWallet[] => {
  const own = new Set(ownKeyHashes.map((h) => h.toLowerCase()))
  if (own.size === 0) return []
  return rows
    .map((row) => ({row, matched: [...new Set(row.keyHashes.filter((h) => own.has(h.toLowerCase())))]}))
    .filter(({matched}) => matched.length > 0)
    .sort((a, b) => a.row.blockHeight - b.row.blockHeight || a.row.txHash.localeCompare(b.row.txHash))
    .map(({row, matched}) => ({
      txHash: row.txHash,
      blockHeight: row.blockHeight,
      name: row.name,
      matched,
      scriptHashes: row.scriptHashes,
      participants: row.participants,
    }))
}

/**
 * One winner per credential: the oldest registration naming it.
 *
 * A later registration naming a credential an earlier one already claimed is
 * ignored — that is the rule, and ignoring it silently is correct. Surfacing
 * "somebody else also registered your key" would be an alarm a user cannot act on,
 * since anyone may publish any metadata about any credential at any time.
 */
export const oldestPerCredential = (matches: readonly DiscoveredWallet[]): ReadonlyMap<string, DiscoveredWallet> => {
  const winners = new Map<string, DiscoveredWallet>()
  // `matches` is already oldest-first, so the first writer for a credential wins
  // and later ones are skipped.
  for (const match of matches) {
    for (const credential of match.matched) {
      if (!winners.has(credential)) winners.set(credential, match)
    }
  }
  return winners
}

/** A Koios row as returned by `tx_info` with `_metadata` and `_scripts`. */
type KoiosTxInfo = {
  readonly tx_hash?: unknown
  readonly block_height?: unknown
  readonly metadata?: unknown
  readonly native_scripts?: unknown
}

const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}

/**
 * Read one `tx_info` row, or `null` when it carries no label-1854 record.
 *
 * Everything is read defensively: this is a stranger's metadata, shaped however
 * they chose, and a reader that assumed its own format would be trusting exactly
 * the party the oldest-wins rule exists to defend against.
 */
export const rowFromTxInfo = (raw: unknown): RegistrationRow | null => {
  // Through `record` first: a `null` row would otherwise throw here and take the
  // whole run down over one bad entry in a batch.
  const tx = record(raw) as KoiosTxInfo
  const txHash = typeof tx.tx_hash === 'string' ? tx.tx_hash : null
  const blockHeight = typeof tx.block_height === 'number' ? tx.block_height : null
  if (txHash === null || blockHeight === null) return null

  const label = record(record(tx.metadata)[CIP146_LABEL_KEY])
  // No label-1854 record is not an error: `tx_by_metalabel` is exact, but a
  // caller may hand us any transaction.
  if (Object.keys(label).length === 0) return null

  const scripts = Array.isArray(tx.native_scripts) ? tx.native_scripts : []
  const keyHashes = scripts.flatMap((s) => keyHashesOf(record(s).script_json as ScriptJson | undefined))
  const scriptHashes = scripts
    .map((s) => record(s).script_hash)
    .filter((h): h is string => typeof h === 'string')
    .map((h) => h.toLowerCase())
  // A registration naming nobody can never match, so it is dropped rather than
  // carried through every comparison.
  if (keyHashes.length === 0) return null

  const participants = record(label.participants)
  return {
    txHash,
    blockHeight,
    name: typeof label.name === 'string' && label.name !== '' ? label.name : undefined,
    keyHashes,
    scriptHashes,
    participants: Object.fromEntries(
      Object.entries(participants).map(([tag, value]) => {
        const name = record(value).name
        return [tag, typeof name === 'string' ? {name} : {}]
      }),
    ),
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Koios caps a request body; `tx_info` takes hashes in batches well under it. */
const TX_INFO_BATCH = 40

/**
 * A search that could not see the whole set. Never a result.
 *
 * **Under-reporting is the dangerous direction here.** A partial read says "no
 * published wallet names your keys", which may be false — and if the part missed
 * held the *oldest* registration for a credential, the rule hands authority to a
 * later one, which is exactly the outcome it exists to prevent. So a failed read
 * fails the search rather than shrinking it.
 */
export class DiscoveryError extends Data.TaggedError('DiscoveryError')<{readonly reason: string}> {}

/**
 * Every label-1854 transaction hash, from `afterBlockHeight` onward.
 *
 * The whole set, deliberately — the oldest-wins rule is only correct over all of
 * them. `afterBlockHeight` is for *resuming*, against a watermark the caller
 * stored, not for sampling.
 */
export const fetchRegistrationHashes = (
  koiosUrl: string,
  afterBlockHeight: number | undefined,
  fetchImpl: FetchLike,
): Effect.Effect<readonly string[], DiscoveryError> =>
  Effect.tryPromise({
    try: async () => {
      const after = afterBlockHeight === undefined ? '' : `&_after_block_height=${afterBlockHeight}`
      const r = await fetchImpl(`${koiosUrl}/tx_by_metalabel?_label=1854${after}`, {
        headers: {Accept: 'application/json'},
      })
      if (!r.ok) throw new Error(`tx_by_metalabel ${r.status}`)
      const rows: unknown = await r.json()
      return (Array.isArray(rows) ? rows : [])
        .map((row) => record(row).tx_hash)
        .filter((h): h is string => typeof h === 'string')
    },
    catch: (e) => new DiscoveryError({reason: e instanceof Error ? e.message : String(e)}),
  })

/**
 * Resolve hashes to registration rows, batched under the request-body cap.
 *
 * A failed batch fails the whole resolve, for the reason on {@link DiscoveryError}
 * — skipping it would drop registrations silently, and the answer built from what
 * survived would look complete. A row that is not a registration is a different
 * thing and is dropped: that is a judgement about content, not a gap in coverage.
 */
export const fetchRegistrationRows = (
  koiosUrl: string,
  txHashes: readonly string[],
  fetchImpl: FetchLike,
): Effect.Effect<readonly RegistrationRow[], DiscoveryError> =>
  Effect.tryPromise({
    try: async () => {
      const out: RegistrationRow[] = []
      for (let i = 0; i < txHashes.length; i += TX_INFO_BATCH) {
        const batch = txHashes.slice(i, i + TX_INFO_BATCH)
        const r = await fetchImpl(`${koiosUrl}/tx_info`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json', Accept: 'application/json'},
          body: JSON.stringify({_tx_hashes: batch, _metadata: true, _scripts: true}),
        })
        if (!r.ok) throw new Error(`tx_info ${r.status}`)
        const rows: unknown = await r.json()
        for (const raw of Array.isArray(rows) ? rows : []) {
          const row = rowFromTxInfo(raw)
          if (row !== null) out.push(row)
        }
      }
      return out
    },
    catch: (e) => new DiscoveryError({reason: e instanceof Error ? e.message : String(e)}),
  })
