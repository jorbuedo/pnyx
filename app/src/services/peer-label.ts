/**
 * The handle to show for an identity, if it has one.
 *
 * A label needs **both** halves of a claim to agree. `identity(C).primaryName` is a row its own owner
 * writes, so on its own it proves nothing — anyone can write `alice` into their row and be drawn as
 * Alice. What makes a name theirs is `handle(name).owner` in the name's own contract, and no contract
 * can check the other because contract-to-contract calls do not exist on Midnight. So the reader joins
 * them: {@link verifyRowName}, which folds both spellings before comparing and refuses to render a name
 * it could not verify.
 *
 * `decodeHandle` still runs first, inside that join: it re-derives the canonical encoding and refuses
 * anything that is not byte-identical, so a decomposed or upper-case spelling of someone else's name
 * never reaches the comparison.
 *
 * **Memoised, because a lookup is a promise and a promise cannot resolve before the first paint.** That
 * is what made every remount draw the id and then replace it with the name. The memo exists to be
 * readable **synchronously** ({@link knownPeerHandle}), which is the only thing that removes that swap.
 *
 * ⚠️ **Two contracts decide an answer, so two things retire it.**
 *
 * | what changes | what notices |
 * |---|---|
 * | the peer renames, clears or publishes their row | their identity contract's height — one contract per identity, so this is *their* height, not a global one |
 * | their name is banned or burned | nothing we hold: it moves the *handle* contract, which we only learn about by asking again |
 *
 * The first is exact. The second cannot be, which is why an answer that consulted a handle contract
 * expires ({@link VERDICT_TTL_MS}).
 *
 * ⚠️ **The first is exact only while something keeps reading that contract, and nothing does.**
 * `contractStateGenerationAt` reports the height of the *cached* state, never the chain — so an entry
 * this memo considers fresh suppresses the read that would move the height that would retire it. A
 * closed loop: a peer who had no name when we first asked keeps having no name for the life of the
 * process. That is exactly what happened when a peer claimed a handle mid-session and the app went on
 * drawing their id.
 *
 * So a lookup revalidates an entry older than {@link HEIGHT_TRUST_MS} rather than trusting it. The
 * height check stays as the fast, exact invalidation; the bound is what re-opens the loop, and it is
 * cheap because revalidating an unmoved contract is a marker query, not a state download.
 *
 * @module
 */

import {hasHandle} from '@pnyx/contract-client/handle'
import {hex} from '@pnyx/crypto'
import {logger} from '../logger'
import {verifyRowName} from './handle-resolve'
import {identityContractAddressForPnyxId} from './identity-contract'
import {type IdentityLookup, resolveIdentityRow} from './identity-row'
import {contractStateGenerationAt} from './pnyx-contract-state'

const ORIGIN = 'peer-label'

/**
 * How long a verdict that rested on a handle contract stays good.
 *
 * A ban or a burn is a moderation action, and ten minutes is how long a client may keep drawing a name
 * after one — bounded, rather than the "until the process restarts" this had before the join existed.
 */
const VERDICT_TTL_MS = 10 * 60_000

/**
 * How long a height nobody has re-read is trusted before a lookup revalidates it.
 *
 * ⚠️ **Not a guess about how often names change — a bound on a check that cannot fire by itself.** The
 * height comparison is exact and free, but it reads the *cached* state, and this memo is what
 * suppresses the read that would move it. Something has to re-open the loop.
 *
 * Five minutes because of what a lapse costs: the state reader answers "has it moved" with a ~277-byte
 * marker and only downloads the ~20 kB blob when it has. So one peer costs a marker every five minutes
 * while you are looking at them — not a state download, and nothing at all for peers on no screen. A
 * name a peer claims mid-conversation therefore appears within five minutes at worst, and immediately
 * when they next message you ({@link forgetPeerHandle} is called on arrival).
 */
const HEIGHT_TRUST_MS = 5 * 60_000

/** Has this peer's entry outlived the window in which an unread height can be trusted? */
const heightWorthRechecking = (pnyxId: string): boolean => {
  const entry = memo.get(pnyxId)
  return entry !== undefined && Date.now() - entry.checkedAt >= HEIGHT_TRUST_MS
}

/** What we decoded for one peer, and everything that can retire it. */
type Entry = {
  readonly handle: string | undefined
  /**
   * The row's own name, whether or not a handle contract backs it.
   *
   * A nickname and a handle are the same bytes in the same field — `identity(C).primaryName` — and
   * what separates them is only whether `handle(name).owner` agrees. So both come out of one read,
   * and this is the half that needs no handle contract at all.
   */
  readonly nickname: string | undefined
  /** When this entry was written, so a height nobody re-reads cannot be trusted for ever. */
  readonly checkedAt: number
  /** The peer's own identity contract, and the height their row was read at. */
  readonly identity: {readonly address: string; readonly height: number}
  /**
   * The handle contract the verdict rested on, when one was read at all.
   *
   * `undefined` for an answer no handle contract took part in — no row, or a row naming nothing — and
   * those need no expiry, because the identity height already covers every way they can change.
   */
  readonly verified: {readonly address: string; readonly height: number | undefined; readonly until: number} | undefined
}

/**
 * `pnyxId → what we decoded, and what it rests on`.
 *
 * `handle: undefined` is cached too — "this peer has no name" is an answer worth not re-deriving, and
 * it is the common case.
 */
const memo = new Map<string, Entry>()

/**
 * Lookups in flight, so two surfaces asking about the same peer at once perform **one** read.
 *
 * ⚠️ **The memo cannot do this.** It is written when a lookup *finishes*, so two callers a frame
 * apart both miss it and both run the whole join — the identity-row read *and* the handle-contract
 * verification, each of which derives an address and so fetches the artifact manifest. That is
 * exactly what the DM thread screen did: its own `usePeerHandles([peer])` and the app-wide unread
 * hook resolved the same peer concurrently, and the peer's handle was verified twice, 37 ms apart,
 * with two separate fetches of `handle/manifest.json`.
 */
const inFlight = new Map<string, Promise<Resolved>>()

/**
 * Both facts a row yields: the registered handle, and the name as written.
 *
 * Returned together because they come from one read. `handle` is set only when a handle contract
 * agreed; `nickname` is set whenever the row names anything this client will render.
 */
type Resolved = {readonly handle: string | undefined; readonly nickname: string | undefined}

/**
 * What {@link peerHandleFor} would return for `pnyxId`, if it is already known for the state we hold.
 *
 * Synchronous and side-effect-free, so a render can seed itself from it. `null` means "not known
 * yet" — distinct from a cached `undefined`, which means "known to have no handle". A caller that
 * collapsed the two would go back to rendering an id it is about to replace.
 */
export const knownPeerHandle = (pnyxId: string): string | undefined | null => {
  const entry = memo.get(pnyxId)
  if (entry === undefined) return null
  // Not "has it moved" but "is this still the state we read": an evicted entry answers `undefined`
  // here, and treating that as unchanged would let a verdict outlive every signal that retires it.
  if (contractStateGenerationAt(entry.identity.address) !== entry.identity.height) return null
  if (entry.verified === undefined) return entry.handle
  if (Date.now() >= entry.verified.until) return null
  if (contractStateGenerationAt(entry.verified.address) !== entry.verified.height) return null
  return entry.handle
}

/**
 * The peer's nickname — the name their row carries, with no claim that anyone backs it.
 *
 * ⚠️ **Checks the identity height and nothing else, deliberately.** A nickname depends only on the
 * row, so none of the handle-contract machinery above bears on it: expiring a nickname when a
 * *handle* verdict's TTL lapses would re-read for a fact that cannot have changed, and flicker the
 * name while it did. `null` means "not known yet", exactly as in {@link knownPeerHandle}.
 */
export const knownPeerNickname = (pnyxId: string): string | undefined | null => {
  const entry = memo.get(pnyxId)
  if (entry === undefined) return null
  if (contractStateGenerationAt(entry.identity.address) !== entry.identity.height) return null
  return entry.nickname
}

/** Drop every memoised handle. For tests, and for a network switch. */
export const resetPeerLabelCache = (): void => {
  memo.clear()
  inFlight.clear()
}

/**
 * Forget one peer, so the next {@link peerHandleFor} asks the chain again.
 *
 * ⚠️ **A poll needs this.** The memo answers a hit without reading any state, so the heights it keys on
 * never move and a loop calling {@link peerHandleFor} re-reads its own first answer until it times out.
 * That is what a claim's "wait for the row to say the name" does, and why it had to be re-tapped: the
 * write landed and the wait could not see it. Retiring the entry is what turns the next call into a read.
 */
export const forgetPeerHandle = (pnyxId: string): void => {
  memo.delete(pnyxId)
  // ⚠️ The in-flight entry goes as well, or the next call joins a lookup that started *before* the
  // write this forgetting exists to notice — which is the stale answer, arriving by a longer route.
  inFlight.delete(pnyxId)
}

/**
 * `pnyxId`'s canonical handle, or `undefined` when it has none, holds a name the handle contract does
 * not agree is theirs, or could not be read.
 *
 * Every failure collapses to `undefined` because they share one consequence — show the id instead.
 * Unlike the DM-start path, "we could not look" and "they have no handle" lead to the same pixels, so
 * distinguishing them here would buy nothing. They are still logged apart.
 */
export const peerHandleFor = async (pnyxId: string): Promise<string | undefined> => (await resolvePeer(pnyxId)).handle

/**
 * The peer's nickname, read the same way and from the same lookup as {@link peerHandleFor}.
 *
 * Asking for both costs one read: `resolvePeer` is shared and in-flight-deduplicated, so a surface
 * that wants the name and its registration status does not pay twice.
 */
export const peerNicknameFor = async (pnyxId: string): Promise<string | undefined> =>
  (await resolvePeer(pnyxId)).nickname

/** Both facts, from the memo when it still applies and from a single shared read when it does not. */
const resolvePeer = async (pnyxId: string): Promise<Resolved> => {
  const handle = knownPeerHandle(pnyxId)
  const nickname = knownPeerNickname(pnyxId)
  // ⚠️ The bound applies here and not in `knownPeerHandle`, which a render reads synchronously to
  // avoid drawing an id it is about to replace. Staleness for one frame is invisible; a network read
  // per render is not.
  //
  // Both halves must be known: the nickname survives a lapsed handle verdict, so one can be current
  // while the other is not, and answering from the fresh half alone would report "no handle" for a
  // peer whose handle we simply have not re-checked.
  if (handle !== null && nickname !== null && !heightWorthRechecking(pnyxId)) return {handle, nickname}
  const running = inFlight.get(pnyxId)
  if (running !== undefined) return running
  const lookup = look(pnyxId).finally(() => inFlight.delete(pnyxId))
  inFlight.set(pnyxId, lookup)
  return lookup
}

/** The read itself. Never rejects — every failure collapses to `undefined`, as documented above. */
const look = async (pnyxId: string): Promise<Resolved> => {
  try {
    // Derived before the lookup rather than returned by it: the memo keys on *this* peer's contract, so
    // an answer that cannot name the contract it came from cannot be cached at all.
    const identityAddress = hex.encode(await identityContractAddressForPnyxId(pnyxId))
    const lookup = await resolveIdentityRow(pnyxId)
    if (lookup.kind === 'unavailable') {
      // Deliberately not memoised: we learned nothing about this peer, and caching the fallback would
      // pin "no name" until the contract next moves — an outage outliving itself.
      logger.debug('no row for peer; showing the id', {origin: ORIGIN, kind: lookup.kind})
      return NOTHING
    }
    return await decide(pnyxId, identityAddress, lookup)
  } catch (error) {
    logger.debug('peer handle lookup failed; showing the id', {origin: ORIGIN, error: String(error)})
    return NOTHING
  }
}

/** No name of either kind. Named so the failure arms read as one answer rather than two undefineds. */
const NOTHING: Resolved = {handle: undefined, nickname: undefined}

/**
 * The label a successfully-read lookup earns, memoised against everything it rested on.
 *
 * **Two answers, and the second one always renders.** A row's name is shown either way — as a
 * registered handle when its handle contract agrees, and as a plain nickname when it does not. The
 * old rule drew nothing in the second case, which is what made a name require a permit, a handle
 * deploy and a `bind` before anyone could see it.
 *
 * ⚠️ **Every verdict short of `valid` falls back to the nickname, including `banned`.** Moderation
 * withholds the handle; it does not suppress the person's name. And an unreadable handle contract
 * must never promote one — the uncertain direction is always the weaker claim.
 */
const decide = async (
  pnyxId: string,
  identityAddress: string,
  lookup: Exclude<IdentityLookup, {kind: 'unavailable'}>,
): Promise<Resolved> => {
  if (lookup.kind !== 'row') {
    logger.debug('no row for peer; showing the id', {origin: ORIGIN, kind: lookup.kind})
    return remember(pnyxId, identityAddress, NOTHING, undefined)
  }
  if (!hasHandle(lookup.row.name)) return remember(pnyxId, identityAddress, NOTHING, undefined)

  // The row's own spelling, which is the nickname whatever the handle contract goes on to say. Read
  // through `decodeHandle` because a row holding bytes the charset refuses must render as nothing
  // rather than as a nickname — a hostile client can write anything, and that check is the only
  // defence there is.
  const {decodeHandle} = await import('@pnyx/contract-client/handle')
  const decoded = decodeHandle(lookup.row.name)
  if (!decoded.ok) {
    logger.debug('a peer’s row name is not renderable at all; showing the id', {
      origin: ORIGIN,
      reason: decoded.reason,
    })
    return remember(pnyxId, identityAddress, NOTHING, undefined)
  }
  const nickname = decoded.display

  const {validity, source} = await verifyRowName(pnyxId, lookup.row.name)
  if (validity.kind === 'valid') {
    // Logged on the way *through*, not only on failure: a name that renders because both contracts
    // agreed and a name that renders because nothing checked look identical on screen, and the second
    // is the defect this module exists to prevent. Silence here would make them indistinguishable.
    logger.debug('a peer’s row name verified against its handle contract', {
      origin: ORIGIN,
      handle: validity.display,
      contract: source?.address,
    })
    // `display`, not the canonical form: the row carries the spelling its owner chose, and folding is
    // only for deciding *which* name it is. Returning the folded form renders everyone in lower case.
    return remember(pnyxId, identityAddress, {handle: validity.display, nickname}, source)
  }
  // ⚠️ `unverifiable` is the one verdict that must not be cached: it means the handle contract could
  // not be read, and pinning a verdict on an outage is the same defect as caching a failed row read.
  // ⚠️ `no-namespace` is explicitly *not* in that class, and the distinction is load-bearing: it says
  // this build has no permit issuer, which is a fact about the build and cannot change under us. When
  // the two were one kind, every lookup on a namespace-free build re-ran the whole join for ever.
  const unverifiable = validity.kind === 'unrenderable' && validity.reason === 'unverifiable'
  logger.debug('a peer’s row name earns no handle; showing it as a nickname', {
    origin: ORIGIN,
    verdict: validity.kind,
    reason: validity.kind === 'unrenderable' ? validity.reason : undefined,
    nickname,
  })
  // Still the nickname, even uncached: not knowing whether a handle backs the name is no reason to
  // withhold the name itself.
  if (unverifiable) return {handle: undefined, nickname}
  return remember(pnyxId, identityAddress, {handle: undefined, nickname}, source)
}

/** Memoise a definite answer against the heights it was read at, and pass it through. */
const remember = (
  pnyxId: string,
  identityAddress: string,
  resolved: Resolved,
  source: {readonly address: string; readonly height: number | undefined} | undefined,
): Resolved => {
  const height = contractStateGenerationAt(identityAddress)
  // Nothing cached for the contract we just read means nothing to key on, so there is no entry to
  // make: answering from an unkeyed cache is answering from a cache that can never be wrong-checked.
  if (height === undefined) return resolved
  memo.set(pnyxId, {
    handle: resolved.handle,
    nickname: resolved.nickname,
    checkedAt: Date.now(),
    identity: {address: identityAddress, height},
    verified: source === undefined ? undefined : {...source, until: Date.now() + VERDICT_TTL_MS},
  })
  return resolved
}
