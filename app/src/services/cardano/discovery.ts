/**
 * Seedless Cardano address discovery.
 *
 * Derives the CIP-1852 address book from the STORED account xpub (no mnemonic,
 * no ceremony), gap-limit scans external (role 0) + internal (role 1) against a
 * usage probe, and persists the discovered rows into the address table. The
 * returned bech32 set (every used address + the primary receive address) is the
 * rail's multi-address `knownAddresses` feed.
 *
 * @module
 */

import {Address as EvolutionAddress, type Provider as EvolutionProvider, RewardAddress} from '@evolution-sdk/evolution'
import {Bech32} from '@evolution-sdk/review/Brands'
import {Address} from '@pnyx/cardano-core'
import type {AddressRef, AddressRow} from '@pnyx/store/address-table'
import type {StoreErrors} from '@pnyx/store/errors'
import {type CardanoBookAddress, DEFAULT_GAP_LIMIT, type DerivationError, deriveCardanoAddressBook} from '@pnyx/wallet'
import {Data, Effect, Schedule} from 'effect'
import {logger} from '../../logger'
import {storage} from '../../platform/storage'

/**
 * Backoff for a refused probe. Three tries over ~1.2s: enough to ride out a
 * burst-rate refusal without turning a genuinely unreachable endpoint into a
 * long stall.
 */
const PROBE_RETRY = Schedule.intersect(Schedule.exponential('150 millis', 2), Schedule.recurs(3))

/** A usage probe could not answer — the network failed, not "this address is unused". */
export class UsageProbeError extends Data.TaggedError('UsageProbeError')<{readonly reason: string}> {}

/**
 * The gap scan's bech32 to the chain client's decoded address.
 *
 * ⚠️ Inside the typed channel, never as a bare call: every probe below is `yield*`-ed by the
 * walk, so a throw from `fromBech32` would be a defect that bypasses the `UsageProbeError`
 * handling, and a malformed derivation deserves to stop the scan with a reason rather than
 * crash it. ⚠️ Also one implementation: the walk and its address book work in bech32 because
 * that is what the address table stores, so this is the edge, and three copies of it were
 * exactly how two callers came to disagree about what an account owns.
 */
const decoded = (bech32: Bech32): Effect.Effect<EvolutionAddress.Address, UsageProbeError> =>
  Effect.try({
    try: () => EvolutionAddress.fromBech32(bech32),
    catch: (cause) => new UsageProbeError({reason: `derived address did not decode: ${String(cause)}`}),
  })

/**
 * Reports whether a bech32 address has **ever** been used on chain.
 *
 * "Ever" is the operative word: current holdings are not the question, because a
 * spent-out address is still used, still ours, and still carries history. A
 * probe that answers from UTxO presence reports every address of a spent-out
 * wallet as unused, which collapses the gap scan onto its first window.
 *
 * A probe may fail. It must not answer `false` when it does not know — that
 * turns a rate-limit into "this account has no addresses" and truncates the scan
 * silently.
 */
export type CardanoUsageProbe = (bech32: Bech32) => Effect.Effect<boolean, UsageProbeError>

/**
 * "Which of these addresses has the chain ever seen?" — the used-set for a whole
 * batch in one answer, rather than one probe per address.
 *
 * The result is a subset of the input: an address in it is used, an address absent
 * from it is unused. Same contract as {@link CardanoUsageProbe} on failure — it
 * must fail rather than answer an empty set it is not sure of.
 */
export type BatchUsedSet = (bech32s: readonly Bech32[]) => Effect.Effect<ReadonlySet<string>, UsageProbeError>

type ScannedAddress = {readonly addr: CardanoBookAddress; readonly isUsed: boolean}

/**
 * Everything the scan can ask about address usage.
 *
 * `known` is the free answer — a previous scan's positives, or this run's memo.
 * Only *positives* may be seeded from a previous run: "used" is permanent, while
 * a previously-unused address becomes used the moment someone pays it, and
 * trusting a stale negative is how a wallet stops recognising its own address.
 *
 * `anyUsed` answers "was any of these ever used?" in one call. It cannot say
 * *which*, so a positive answer still needs a per-address pass — but a negative
 * clears a whole window at once, and an untouched window is exactly what the gap
 * rule terminates on.
 */
export type UsageOracle = {
  readonly known: (bech32: string) => boolean | undefined
  readonly probe: CardanoUsageProbe
  readonly anyUsed?: (bech32s: readonly Bech32[]) => Effect.Effect<boolean, UsageProbeError>
  /**
   * Answers a whole window at once: which of these has the chain ever seen.
   *
   * Unlike `anyUsed` this is per-address, so a window it answers needs no probing
   * at all — the scan's cost drops from one call per address to one per window.
   * It must record what it learned where `known`/`probe` can see it, so the loop
   * below reads the answers back through the ordinary path.
   *
   * ⚠️ Its failure mode is UNDER-reporting: an oracle that omits a used address
   * makes the wallet stop recognising its own money. It is only safe on a source
   * that answers from history rather than from current holdings.
   */
  readonly usedAmong?: (bech32s: readonly Bech32[]) => Effect.Effect<void, UsageProbeError>
}

/**
 * Gap-limit scan of one role's addresses. Walks in index order, keeping every
 * scanned address with its used flag, and stops after `gapLimit` consecutive
 * unused addresses. A used address resets the run (used-index extension).
 *
 * A window is answered by `usedAmong` in one call when the oracle offers it, so
 * the per-address loop below reads every result from the memo. Failing that, a
 * window whose addresses are all unknown is *cleared* by a single `anyUsed` call;
 * everything else falls back to per-address probing, which is free for addresses
 * the oracle already knows.
 */
export const scanCardanoRole = (
  role: readonly CardanoBookAddress[],
  oracle: UsageOracle,
  gapLimit: number,
  /**
   * Called with each window's results as it lands, before the scan continues.
   *
   * ⚠️ **The scan used to publish nothing until it had finished.** A wallet with
   * hundreds of used addresses takes minutes of paced probing, and for all of it the
   * address table stayed empty — so a dApp asking "which addresses have you used"
   * during the walk was told "one", indistinguishable from a wallet that has one.
   * Worse, an interrupted walk threw away everything it had learned and started over.
   *
   * Publishing per window makes the answer grow instead of appearing at the end, and
   * makes progress durable. `upsert` replaces by (group, chain, account, branch, index),
   * so a re-scan overwrites its own rows rather than duplicating them.
   */
  onWindow?: (scanned: readonly ScannedAddress[]) => Effect.Effect<void, never>,
): Effect.Effect<readonly ScannedAddress[], UsageProbeError> =>
  Effect.gen(function* () {
    const out: ScannedAddress[] = []
    let consecutiveUnused = 0
    let published = 0
    /** Hand over everything scanned since the last hand-over. */
    const publish = Effect.suspend(() => {
      if (onWindow === undefined || out.length === published) return Effect.void
      const fresh = out.slice(published)
      published = out.length
      return onWindow(fresh)
    })

    for (let start = 0; start < role.length; start += gapLimit) {
      const window = role.slice(start, start + gapLimit)

      const unknown = window.filter((a) => oracle.known(a.bech32) === undefined)

      if (oracle.usedAmong !== undefined && unknown.length > 0) {
        yield* oracle.usedAmong(unknown.map((a) => Bech32(a.bech32)))
      } else if (oracle.anyUsed !== undefined && window.length > 1 && unknown.length === window.length) {
        const used = yield* oracle.anyUsed(window.map((a) => Bech32(a.bech32)))
        if (!used) {
          for (const addr of window) {
            out.push({addr, isUsed: false})
            consecutiveUnused++
            if (consecutiveUnused >= gapLimit) {
              yield* publish
              return out
            }
          }
          yield* publish
          continue
        }
      }

      for (const addr of window) {
        const isUsed = yield* oracle.probe(Bech32(addr.bech32))
        out.push({addr, isUsed})
        if (isUsed) {
          consecutiveUnused = 0
        } else {
          consecutiveUnused++
          if (consecutiveUnused >= gapLimit) {
            yield* publish
            return out
          }
        }
      }
      yield* publish
    }
    yield* publish
    return out
  })

/** Map a Provider network to the address-encoding network. */
export const addressNetworkFor = (network: 'mainnet' | 'preprod' | 'preview'): Address.Network =>
  network === 'mainnet' ? Address.Network.Mainnet : Address.Network.Testnet

const rowFor = (ref: AddressRef, {addr, isUsed}: ScannedAddress): AddressRow => ({
  ...ref,
  branch: addr.role === 0 ? 'external' : 'internal',
  index: addr.index,
  human: addr.bech32,
  hash: addr.paymentKeyHashHex,
  isUsed,
})

/**
 * Caller-supplied cost reducers for a re-scan: what a previous scan already
 * proved used, and a one-call window probe. Both are optional — discovery is
 * correct without them, just slower.
 */
export type CardanoDiscoveryOptions = {
  readonly alreadyUsed?: ReadonlySet<string>
  readonly anyUsed?: (bech32s: readonly Bech32[]) => Effect.Effect<boolean, UsageProbeError>
  readonly seenAmong?: BatchUsedSet
}

export type CardanoDiscoveryResult = {
  /** Every scanned address (external + internal) with its used flag, as persisted. */
  readonly rows: readonly AddressRow[]
  /** The addresses the rail should sync: every used address plus the primary receive address. */
  readonly knownAddresses: readonly string[]
}

/**
 * Address books already derived in this process, keyed by (account xpub, network, role).
 *
 * ⚠️ **The scan re-derived its whole book every time it ran, and it runs every five
 * minutes.** Measured on a 664-address wallet: 800 CKDpub derivations, 12.4 s of a 17 s
 * walk — paid again on every re-scan, for a book that cannot have changed. The
 * derivation is pure and deterministic over (xpub, network, role, index), so serving it
 * from memory is the same answer, not a cheaper approximation.
 *
 * ⚠️ **The network belongs in the key.** A cache of derived addresses keyed only by the
 * xpub is how one network's addresses get served on another
 * ([[connector-served-another-networks-balance]] was exactly that shape).
 *
 * This is a process-level memo, not a substitute for the address table: a cold start
 * still derives, which is what keeps ownership gated on our own derivation rather than
 * on rows read back from disk.
 */
const derivedBooks = new Map<string, CardanoBookAddress[]>()

/**
 * How many role-books to keep. A book is at most a few hundred small objects, and a
 * session touches one per (wallet, account, role) — a cap rather than a policy, so the
 * memo cannot grow without bound in a session that visits many wallets.
 */
const MAX_CACHED_BOOKS = 16

const bookKey = (accountXpubHex: string, network: Address.Network, role: 0 | 1): string =>
  `${accountXpubHex}/${network}/${role}`

/** Drop every memoized book. For tests, and for a wallet reset that invalidates an xpub. */
export const clearDerivedAddressBooks = (): void => {
  derivedBooks.clear()
}

const INITIAL_SCAN = 40

/**
 * Derive the address book from the account xpub, gap-limit scan both roles via
 * the probe, and persist the discovered rows. Pure over the injected probe +
 * `upsert` — the network dependency is the address-encoding network only.
 *
 * The scan is DYNAMIC: it grows the derived book until each role's gap-scan
 * terminates on a full gap window rather than truncating at a fixed book size.
 * The gap rule is the sole, sufficient bound — for a FINITE account set the scan
 * always hits `gapLimit` consecutive unused past the last used index, so it
 * always terminates. No numeric ceiling: one would truncate a legitimately
 * sparse wallet (e.g. every 5th index used ⇒ few used addresses spread across
 * many indices). Probe results are memoized so re-scans over a grown book never
 * re-probe — free for the account-set membership probe, and it keeps the
 * network-backed UTxO fallback from re-hitting the provider on growth.
 *
 * `alreadyUsed` seeds that memo with a previous scan's positives (the persisted
 * `isUsed` rows), so a re-scan pays the network only for the frontier. Negatives
 * are deliberately NOT seeded — see {@link UsageOracle}.
 */
export const discoverAndPersistCardanoAddresses = (params: {
  readonly accountXpubHex: string
  readonly network: Address.Network
  readonly ref: AddressRef
  readonly probe: CardanoUsageProbe
  readonly upsert: (rows: readonly AddressRow[]) => Effect.Effect<void, StoreErrors>
  readonly gapLimit?: number
  /** Addresses a previous scan already proved used. */
  readonly alreadyUsed?: ReadonlySet<string>
  /** One-call "was any of these ever used?", when the provider can answer it. */
  readonly anyUsed?: (bech32s: readonly Bech32[]) => Effect.Effect<boolean, UsageProbeError>
  /** One-call "which of these has the chain seen?", when the provider can answer it. */
  readonly seenAmong?: BatchUsedSet
}): Effect.Effect<CardanoDiscoveryResult, DerivationError | StoreErrors | UsageProbeError> =>
  Effect.gen(function* () {
    const gapLimit = params.gapLimit ?? DEFAULT_GAP_LIMIT

    const cache = new Map<string, boolean>()
    const seenAmong = params.seenAmong
    let batchCalls = 0
    for (const bech32 of params.alreadyUsed ?? []) cache.set(bech32, true)
    const oracle: UsageOracle = {
      known: (a) => cache.get(a),
      probe: (a) =>
        cache.has(a)
          ? Effect.succeed(cache.get(a) as boolean)
          : params.probe(a).pipe(Effect.tap((r) => Effect.sync(() => cache.set(a, r)))),
      ...(params.anyUsed !== undefined ? {anyUsed: params.anyUsed} : {}),
      // The batch answer is complete for what it was asked, so writing it into the
      // memo is what makes the per-address loop free: every address in the window
      // becomes a cache hit, used or not. Negatives are run-scoped only — the same
      // rule the memo already follows for a probe's answer.
      ...(seenAmong !== undefined
        ? {
            usedAmong: (bech32s: readonly Bech32[]) =>
              seenAmong(bech32s).pipe(
                Effect.map((seen) => {
                  batchCalls += 1
                  for (const bech32 of bech32s) cache.set(bech32, seen.has(bech32))
                }),
              ),
          }
        : {}),
    }

    // Grow the book until BOTH roles' scans end on a gap window (return fewer
    // rows than the book) rather than by exhausting the book. gap-20 guarantees
    // termination over a finite account set.
    const startedAt = Date.now()
    let windows = 0
    let persisted = 0
    /**
     * Write one window's rows as the scan produces them.
     *
     * Never fails the scan: a store write that does not land costs this window its
     * durability, and the final upsert below still carries every row. Losing the whole
     * discovery over one failed write would be the worse trade — that is the state this
     * incremental path exists to get out of.
     */
    const onWindow = (scanned: readonly ScannedAddress[]): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        windows += 1
        yield* params.upsert(scanned.map((entry) => rowFor(params.ref, entry))).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              persisted += scanned.length
            }),
          ),
          Effect.catchAll((error) =>
            Effect.sync(() =>
              logger.warn('Cardano discovery could not persist a window; it will land with the final write', {
                origin: 'CardanoDiscovery',
                groupId: params.ref.groupId,
                rows: scanned.length,
                error: String(error),
              }),
            ),
          ),
        )
      })

    logger.info('Cardano discovery started', {
      origin: 'CardanoDiscovery',
      groupId: params.ref.groupId,
      accountIndex: params.ref.accountIndex,
      seededUsed: params.alreadyUsed?.size ?? 0,
    })

    // Timed apart from the scan because the two are fixed by different things and the
    // walk used to be dominated by the network. Now that a window is one call, "the scan
    // is slow" and "the derivation is slow" are different diagnoses, and only this
    // separates them: the loop below re-derives the WHOLE book each time it grows.
    let deriveMs = 0
    let derivations = 0
    let reused = 0
    /**
     * One role's book up to `count`, deriving only what the memo does not already hold.
     *
     * A re-scan within the same process therefore pays nothing: the memo is keyed by
     * (xpub, network, role) and the derivation is deterministic over exactly those plus
     * the index.
     */
    const bookUpTo = (role: 0 | 1, count: number): Effect.Effect<CardanoBookAddress[], DerivationError> =>
      Effect.gen(function* () {
        const key = bookKey(params.accountXpubHex, params.network, role)
        const cached = derivedBooks.get(key) ?? []
        if (cached.length >= count) {
          reused += count
          return cached.slice(0, count)
        }
        reused += cached.length
        const startedDeriveAt = Date.now()
        const grown = yield* deriveCardanoAddressBook(params.accountXpubHex, {
          network: params.network,
          count,
          from: cached.length,
          roles: [role],
        })
        deriveMs += Date.now() - startedDeriveAt
        derivations += count - cached.length
        const book = [...cached, ...(role === 0 ? grown.external : grown.internal)]
        derivedBooks.set(key, book)
        // Map iteration is insertion-ordered, so the first key is the oldest book.
        if (derivedBooks.size > MAX_CACHED_BOOKS) {
          const oldest = derivedBooks.keys().next()
          if (!oldest.done) derivedBooks.delete(oldest.value)
        }
        return book
      })

    /**
     * Grow ONE role's book until its scan ends on a gap window rather than by
     * exhausting the book, and return what it scanned. gap-20 guarantees termination
     * over a finite account set.
     *
     * ⚠️ **Per role, and each of the two words matters.**
     *
     * *Per*: the loop used to re-derive from zero every time it grew, so a book ending
     * at 640 cost 1240 derivations. Extending pays for the book once.
     *
     * *Role*: the two roles have unrelated frontiers and used to share one counter. On
     * the wallet this was measured against, external ended at 89 used addresses and
     * internal at 575 — so external's book was grown to 640 to keep internal company,
     * where 160 was enough. Together: 2480 derivations for a 664-address answer, then
     * 1280, now ~800.
     */
    const growAndScan = (
      role: 0 | 1,
    ): Effect.Effect<
      {readonly scanned: readonly ScannedAddress[]; readonly book: readonly CardanoBookAddress[]},
      DerivationError | UsageProbeError
    > =>
      Effect.gen(function* () {
        let count = Math.max(gapLimit * 2, INITIAL_SCAN)
        let book = yield* bookUpTo(role, count)
        let scanned = yield* scanCardanoRole(book, oracle, gapLimit, onWindow)
        while (scanned.length === book.length) {
          count *= 2
          book = yield* bookUpTo(role, count)
          scanned = yield* scanCardanoRole(book, oracle, gapLimit, onWindow)
        }
        return {scanned, book}
      })

    // External first: its index 0 is the primary receive address, and running the two
    // sequentially keeps one shared probe memo and one paced request stream.
    const externalRole = yield* growAndScan(0)
    const internalRole = yield* growAndScan(1)
    const external = externalRole.scanned
    const internal = internalRole.scanned
    const scanned = [...external, ...internal]

    const rows = scanned.map((s) => rowFor(params.ref, s))
    yield* params.upsert(rows)

    // The line whose absence cost this session hours: a silent scan cannot be told
    // apart from one that never ran, and "Chain wallet sync completed" — a cache read
    // that touches no network — was being read as if it meant this.
    logger.info('Cardano discovery finished', {
      origin: 'CardanoDiscovery',
      groupId: params.ref.groupId,
      accountIndex: params.ref.accountIndex,
      scanned: scanned.length,
      used: scanned.filter((entry) => entry.isUsed).length,
      external: external.length,
      internal: internal.length,
      windows,
      batchCalls,
      deriveMs,
      derivations,
      // 0 derivations is the good case on a re-scan, and it must be distinguishable
      // from a scan that never derived anything because it never ran.
      reusedFromMemo: reused,
      persistedDuringScan: persisted,
      externalBookSize: externalRole.book.length,
      internalBookSize: internalRole.book.length,
      durationMs: Date.now() - startedAt,
    })

    const known = new Set(scanned.filter((s) => s.isUsed).map((s) => s.addr.bech32))
    const primary = externalRole.book[0]?.bech32
    if (primary !== undefined) known.add(primary)

    return {rows, knownAddresses: [...known]} satisfies CardanoDiscoveryResult
  })

/**
 * Usage probe over transaction history — an address with ≥1 transaction has been
 * used, whether or not it still holds anything. This is the correct question:
 * the wallet that surfaced this asked `/address_txs` for a spent-out account and
 * got 1000 txs on index 0 and 6 on index 36, where UTxO presence said 0 for both.
 *
 * `limit: 1` keeps it to an existence check rather than pulling a full history.
 */
export const txHistoryUsageProbe =
  (getTxsAt: NonNullable<EvolutionProvider.ProviderEffect['getTxsAt']>): CardanoUsageProbe =>
  (bech32) =>
    Effect.flatMap(decoded(bech32), (address) =>
      getTxsAt([address], {limit: 1}).pipe(
        // A gap scan is dozens of sequential calls, so a rate-limited endpoint
        // will refuse some of them; that is transient, and failing the whole
        // discovery over it would leave the wallet with no address book at all.
        // Retried here rather than swallowed — the error still surfaces if the
        // endpoint keeps refusing, it just is not believed on the first refusal.
        //
        // ⚠️ Scoped to the request, NOT to the decode above it: an address that does not
        // parse will not parse three times slower.
        Effect.retry(PROBE_RETRY),
        Effect.map((refs) => refs.length > 0),
        Effect.mapError((cause) => new UsageProbeError({reason: `address history probe failed: ${String(cause)}`})),
      ),
    )

/**
 * "Was any of these addresses ever used?" over `/address_txs` — one call for a
 * whole window. A single row proves *someone* in the set has history but not
 * which one, so only the empty answer is actionable; the scan uses it to clear an
 * untouched window and falls back to per-address probing otherwise.
 *
 * The window must stay small enough that the request body clears the proxy cap —
 * the scan asks in gap-limit-sized windows (20), well under it.
 */
export const txHistoryWindowProbe =
  (getTxsAt: NonNullable<EvolutionProvider.ProviderEffect['getTxsAt']>) =>
  (bech32s: readonly Bech32[]): Effect.Effect<boolean, UsageProbeError> =>
    Effect.flatMap(Effect.forEach(bech32s, decoded), (addresses) =>
      getTxsAt(addresses, {limit: 1}).pipe(
        Effect.retry(PROBE_RETRY),
        Effect.map((refs) => refs.length > 0),
        Effect.mapError(
          (cause) => new UsageProbeError({reason: `address window history probe failed: ${String(cause)}`}),
        ),
      ),
    )

/**
 * The batched used-set over a provider's `addressesSeen` (`/address_info` on Koios).
 *
 * This is what turns a gap scan from one paced call per address into one per window:
 * a 611-address wallet was ~6-7 minutes of sequential probing. The endpoint answers
 * from address history, not from current holdings, so a spent-out address is still
 * in the answer — the property the whole substitution rests on, and the one to
 * re-check if the backend ever changes.
 *
 * Anything returned that was not asked about is dropped and logged: the caller reads
 * this as "used", and an address we never derived is not ours to call used.
 */
export const seenAddressUsedSet =
  (getAddressesSeen: NonNullable<EvolutionProvider.ProviderEffect['getAddressesSeen']>): BatchUsedSet =>
  (bech32s) =>
    Effect.flatMap(Effect.forEach(bech32s, decoded), (addresses) => getAddressesSeen(addresses)).pipe(
      Effect.retry(PROBE_RETRY),
      Effect.map((seen) => {
        const asked = new Set(bech32s)
        const used = new Set<string>()
        let foreign = 0
        for (const address of seen) {
          const bech32 = EvolutionAddress.toBech32(address)
          if (asked.has(Bech32(bech32))) used.add(bech32)
          else foreign += 1
        }
        if (foreign > 0) {
          logger.warn('Batched used-set returned addresses that were not asked about; ignoring them', {
            origin: 'CardanoDiscovery',
            asked: asked.size,
            foreign,
          })
        }
        return used as ReadonlySet<string>
      }),
      Effect.mapError((cause) => new UsageProbeError({reason: `batched used-set failed: ${String(cause)}`})),
    )

/**
 * Usage probe from a provider's `utxosAt` — last resort, for a provider with no
 * history surface at all. It can only see addresses that hold something *now*,
 * so it under-reports a spent-out wallet; prefer {@link txHistoryUsageProbe}.
 */
export const utxoUsageProbe =
  (getUtxos: EvolutionProvider.ProviderEffect['getUtxos']): CardanoUsageProbe =>
  (bech32) =>
    Effect.flatMap(decoded(bech32), (address) =>
      getUtxos(address).pipe(
        Effect.retry(PROBE_RETRY),
        Effect.map((utxos) => utxos.length > 0),
        Effect.mapError((cause) => new UsageProbeError({reason: `address utxo probe failed: ${String(cause)}`})),
      ),
    )

/**
 * Build a usage probe from the account's on-chain address set (from
 * `/account_addresses`, fetched once). An address is "used" iff it appears in
 * that set — a free in-memory membership test, so the gap-scan costs zero
 * per-address network calls (vs one `/address_info` each) AND still finds
 * spent-out addresses a UTxO probe misses. The gap-limit still bounds the
 * derivation, and — critically — ownership stays gated on OUR derivation:
 * addresses in the account set that we never derive (foreign payment keys
 * sharing our public stake credential, or scripts) are simply never matched,
 * so an adversarial "mixed" address can't be mistaken for ours.
 */
export const accountAddressUsageProbe =
  (accountAddresses: ReadonlySet<string>): CardanoUsageProbe =>
  (bech32) =>
    Effect.succeed(accountAddresses.has(bech32))

/**
 * Fetch the account's complete on-chain address set, paging until exhausted.
 *
 * ⚠️ The typed read answers decoded addresses and this answers bech32, because the walk, the
 * address book it builds and the table behind it all work in bech32. The conversion is HERE
 * rather than at each caller: it was written inline in three of them.
 */
export const fetchAllAccountAddresses = (
  getAccountAddresses: NonNullable<EvolutionProvider.ProviderEffect['getAccountAddresses']>,
  reward: Bech32,
): Effect.Effect<readonly string[]> =>
  Effect.gen(function* () {
    const PAGE = 1000
    const all: string[] = []
    const stake = RewardAddress.RewardAddress.make(reward)
    for (let offset = 0; offset < 100_000; offset += PAGE) {
      const page = yield* getAccountAddresses(stake, {offset}).pipe(
        Effect.map((addresses) => addresses.map((a) => EvolutionAddress.toBech32(a))),
        Effect.catchAll((e) => {
          logger.warn('Account-address page failed; the discovered book stops here', {
            origin: 'CardanoDiscovery',
            offset,
            error: String(e),
          })
          return Effect.succeed([] as readonly string[])
        }),
      )
      all.push(...page)
      if (page.length < PAGE) break
    }
    return all
  })

/**
 * How long a completed gap scan stays good for. Mirrors the rail's own sync
 * interval: a scan finds addresses that became *used*, which requires a
 * transaction, and the rail already refuses to re-probe the chain more often
 * than this.
 */
export const MIN_DISCOVERY_INTERVAL_MS = 300_000

const discoveryKey = (groupId: string, accountIndex: number): string =>
  `@pnyx/cardano_discovered_at/${groupId}/${accountIndex}`

/**
 * Whether a gap scan is due. `lastAt` is the previous scan's completion time;
 * an absent or unparseable timestamp means "never scanned", which is due.
 */
export const discoveryDue = (lastAt: number | null, now: number, interval = MIN_DISCOVERY_INTERVAL_MS): boolean =>
  lastAt === null || !Number.isFinite(lastAt) || now - lastAt >= interval

/** Read the last scan time for a (group, account), or `null` when never scanned. */
export const loadLastDiscoveredAt = async (groupId: string, accountIndex: number): Promise<number | null> => {
  const raw = await storage.get(discoveryKey(groupId, accountIndex)).catch((e) => {
    logger.warn('Last-discovery read failed; the account will be re-scanned', {
      origin: 'CardanoDiscovery',
      groupId,
      accountIndex,
      error: String(e),
    })
    return null
  })
  if (raw === null) return null
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : null
}

/** Record a completed scan. Best-effort — a failed write only costs a re-scan. */
export const saveLastDiscoveredAt = async (groupId: string, accountIndex: number, at: number): Promise<void> => {
  await storage.set(discoveryKey(groupId, accountIndex), String(at)).catch((e) => {
    logger.warn('Last-discovery write failed; the next mount re-scans', {
      origin: 'CardanoDiscovery',
      groupId,
      accountIndex,
      error: String(e),
    })
  })
}

/**
 * Addresses on-chain under our stake credential that are NOT ours (foreign
 * payment keys sharing our public stake key, DEX-order / escrow scripts, or
 * adversarial "mixed" addresses). Excluded from balance; parked here per group
 * for a future locked-positions view. Never treat these as the wallet's own.
 */
const externalAddressCache = new Map<string, readonly string[]>()
export const setExternalCardanoAddresses = (groupId: string, addresses: readonly string[]): void => {
  externalAddressCache.set(groupId, addresses)
}
export const getExternalCardanoAddresses = (groupId: string): readonly string[] =>
  externalAddressCache.get(groupId) ?? []
