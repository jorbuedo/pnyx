/**
 * Reading a handle contract, and the two questions that need it.
 *
 * A name's address derives from the name alone, so anyone can find its contract; what was missing until
 * 2026-08-26 was the read. `identity.compact` lost its `names` map when handles became one contract per
 * name, and `identity::name_owner` has been a stub that errors since — which left every caller either
 * blocked or, worse, trusting one side of a two-sided rule.
 *
 * ⚠️ **Validity is bidirectional and no contract can check it.** `handle(name).owner` and
 * `identity(C).primaryName` are written independently, because contract-to-contract calls do not exist —
 * so the reader joins them. Trusting the row alone lets anyone write `alice` into their own row and be
 * rendered as Alice; trusting the owner alone renders a name its holder never claimed. The join lives in
 * `@pnyx/contract-client/handle-validity`, once, with its own tests.
 *
 * Reads go to an indexer, not to our service, for the same reason identity rows do: nobody learns which
 * name was looked up.
 *
 * @module
 */

import {canonicalizeHandle, encodeHandle} from '@pnyx/contract-client/handle'
import {
  type HandleFacts,
  type HandleOwnership,
  type HandleValidity,
  handleOwnership,
  handleValidity,
} from '@pnyx/contract-client/handle-validity'
import {decodePnyxId, encodePnyxId} from '@pnyx/contract-client/identity'
import {hex} from '@pnyx/crypto'
import {handleAddress, handleRecord} from '@pnyx/midnight-native'
import {midnightPaymentAddress} from '../config/env'
import {logger} from '../logger'
import {ensureVerifierKeys} from './pnyx-artifacts'
import {contractStateGenerationAt, readPnyxContractState} from './pnyx-contract-state'

const ORIGIN = 'handle-resolve'

/**
 * Addresses are a pure derivation over the name plus the template's verifier keys, so the answer is
 * cached for the process. Keyed by the canonical name; a recompile changes the cache directory the keys
 * come from rather than this map.
 */
const addresses = new Map<string, Uint8Array>()

/** The contract address a name deploys to, or `undefined` when this build has no namespace. */
export const handleContractAddress = async (canonical: string): Promise<Uint8Array | undefined> => {
  const configured = midnightPaymentAddress()
  if (configured === undefined) {
    logger.debug('no payment contract configured, so no handle address can be derived', {origin: ORIGIN})
    return undefined
  }
  const known = addresses.get(canonical)
  if (known !== undefined) return known
  const payment = hex.decode(configured)
  if (payment._tag === 'Left' || payment.right.length !== 32) {
    logger.error('the configured payment address is not 32 bytes of hex', {origin: ORIGIN})
    return undefined
  }
  const keysDir = await ensureVerifierKeys('handle')
  const address = await handleAddress({keysDir, name: encodeHandle(canonical), payment: payment.right})
  addresses.set(canonical, address)
  return address
}

/**
 * A handle contract's facts, together with the state they were read from.
 *
 * `address` and `height` are here because a reader that caches a verdict has to know **which contract
 * at which height** produced it. A ban or a burn moves the handle contract and nothing else, so a
 * cache keyed only on the identity contract cannot notice one — see {@link module:./peer-label}.
 */
export type HandleRead =
  | {
      readonly kind: 'facts'
      readonly facts: HandleFacts
      readonly address: string
      /** `undefined` when the state came back but was not cached, so no height can be quoted. */
      readonly height: number | undefined
    }
  /** Nothing is deployed at the name's address. A definite answer: nobody holds it. */
  | {readonly kind: 'absent'}
  /**
   * This build has no handle namespace: `EXPO_PUBLIC_MIDNIGHT_PAYMENT_ADDRESS` is unset, so there is
   * no issuer of permits and no address a handle could be derived to.
   *
   * ⚠️ **Definite, and that is the whole point of separating it from `unavailable`.** It is a fact
   * about the build rather than a failed read, so a caller may cache it — where `unavailable` must
   * never be cached. Collapsing the two is what made every peer-label lookup on a namespace-free
   * build re-run the entire join for ever: `unavailable` became the `unverifiable` verdict, which
   * `peer-label` deliberately does not memoise.
   *
   * It is a claim about *this build's view*, which is the only view that matters here — a handle
   * claimed against a different payment contract is unreachable from this one by construction.
   */
  | {readonly kind: 'no-namespace'}
  /** We could not look. Must never be read as `absent` — that would say a held name is free. */
  | {readonly kind: 'unavailable'}

/**
 * Read the contract a name deploys to.
 *
 * ⚠️ Three outcomes, not two, and the middle one is the trap: "nothing is deployed" and "we could not
 * ask" lead opposite ways — one says the name is free, the other must never say that.
 */
export const readHandleContract = async (canonical: string): Promise<HandleRead> => {
  // Asked before deriving anything: with no issuer configured there is no namespace to read, and that
  // is a definite answer rather than a failure. `handleContractAddress` folds this case in with
  // malformed config, so the question has to be put here to stay distinguishable.
  if (midnightPaymentAddress() === undefined) return {kind: 'no-namespace'}
  const address = await handleContractAddress(canonical)
  if (address === undefined) return {kind: 'unavailable'}
  const addressHex = hex.encode(address)
  let state: Uint8Array | null
  try {
    state = await readPnyxContractState(addressHex)
  } catch (error) {
    logger.warn('handle contract state read threw', {origin: ORIGIN, address: addressHex, error: String(error)})
    return {kind: 'unavailable'}
  }
  // `readPnyxContractState` answers `null` for "nothing deployed" *and* for "could not ask", and it
  // logs its own failures — so a null after a successful marker query is the deployed-nothing case.
  if (state === null) return {kind: 'absent'}
  try {
    return {
      kind: 'facts',
      facts: await handleRecord(state),
      address: addressHex,
      height: contractStateGenerationAt(addressHex),
    }
  } catch (error) {
    logger.warn('a handle record could not be decoded', {origin: ORIGIN, address: addressHex, error: String(error)})
    return {kind: 'unavailable'}
  }
}

/**
 * What a name's contract says, `null` when nothing is deployed, `undefined` when we could not look.
 *
 * The flat form of {@link readHandleContract}, for callers with no cache to key.
 */
export const readHandleFacts = async (canonical: string): Promise<HandleFacts | null | undefined> => {
  const read = await readHandleContract(canonical)
  // ⚠️ `no-namespace` answers `undefined`, not `null`: `null` here means "nothing is deployed, so the
  // name is free", and offering a name as free on a build that cannot issue the permit to claim it
  // would be a promise nothing can keep.
  return read.kind === 'facts' ? read.facts : read.kind === 'absent' ? null : undefined
}

/**
 * Who holds `canonical`, or `'unknown'` when we could not ask.
 *
 * The storefront's second question, and the one that decides whether anything has to be *bought*: a
 * name this identity already holds needs no permit and no open tier, only the row write that displays
 * it. `'unknown'` rather than a guess on a failed read — refusing a claim on an outage and offering one
 * over somebody else's name are both worse than saying we do not know.
 */
export const readNameOwnership = async (
  canonical: string,
  identity: Uint8Array,
): Promise<HandleOwnership | 'unknown'> => {
  const read = await readHandleContract(canonical)
  if (read.kind === 'unavailable') return 'unknown'
  // ⚠️ `'unknown'`, not `'unbound'`. With no issuer configured nothing is owned, but nothing is
  // claimable either, so answering "takeable" would offer a claim that cannot be completed.
  if (read.kind === 'no-namespace') return 'unknown'
  // Nothing deployed is a definite answer: the address is derived from the name, so an empty address
  // means nobody has ever claimed it.
  if (read.kind === 'absent') return 'unbound'
  return handleOwnership(read.facts, identity)
}

/**
 * Which contract at which height a verdict was read from, so a cache can key on it.
 *
 * `undefined` when no handle contract was reached at all — a row naming nothing, or naming bytes this
 * client will not draw. There is nothing to invalidate against in that case, because nothing was read.
 */
export type VerifiedAgainst = {readonly address: string; readonly height: number | undefined} | undefined

/** A row-name verdict, and the handle contract state it rests on. */
export type RowNameVerdict = {readonly validity: HandleValidity; readonly source: VerifiedAgainst}

/**
 * May `identity` be displayed under the name its row claims?
 *
 * `rowName` is `identity(C).primaryName` verbatim — the display spelling, 32 bytes. Returns the full
 * verdict rather than a boolean so a caller can tell "nobody bound it" from "they own it and are not
 * showing it", which lead to different words on screen.
 */
export const verifyRowName = async (pnyxId: string, rowName: Uint8Array): Promise<RowNameVerdict> => {
  const {decodeHandle} = await import('@pnyx/contract-client/handle')
  const decoded = decodeHandle(rowName)
  if (!decoded.ok) return {validity: {kind: 'unrenderable', reason: decoded.reason}, source: undefined}
  const read = await readHandleContract(canonicalizeHandle(decoded.display))
  if (read.kind !== 'facts') {
    // ⚠️ No handle contract agreed, so this name earns no *handle* — but the caller may still show it
    // as a nickname, which is what `name-display.ts` decides. The kind itself, not a boolean over it:
    // `absent` (nobody ever claimed this name), `no-namespace` (this build has no issuer, a definite
    // and cacheable fact) and `unavailable` (we could not ask, never cacheable) lead to the same
    // pixels and to three different diagnoses.
    logger.debug('a row name could not be verified against its handle contract', {
      origin: ORIGIN,
      read: read.kind,
    })
    return {
      validity: {
        kind: 'unrenderable',
        reason:
          read.kind === 'absent'
            ? 'no-handle-contract'
            : read.kind === 'no-namespace'
              ? 'no-namespace'
              : 'unverifiable',
      },
      source: undefined,
    }
  }
  return {
    validity: handleValidity(read.facts, rowName, decodePnyxId(pnyxId).identity),
    source: {address: read.address, height: read.height},
  }
}

export type HandleResolution =
  /**
   * The name is bound. `pnyxId` is whom to message; `displayHandle` is set **only when the holder's row
   * points back**, and is `undefined` otherwise.
   *
   * ⚠️ **Routing and display are different questions, and only one needs both sides.** Nobody but the
   * holder could have bound this name — `bind` proves knowledge of their `identitySk` — so the handle
   * contract's `owner` is authoritative on its own for *whom to message*. Rendering their name is what
   * needs the row to agree, because a row is a claim anyone can write. Collapsing the two would either
   * refuse to message a real holder or draw a name nobody claimed.
   */
  | {readonly kind: 'held'; readonly pnyxId: string; readonly displayHandle: string | undefined}
  /** Nothing deployed, or deployed and unbound. A definite answer: this name is takeable. */
  | {readonly kind: 'unclaimed'}
  /** Burned or banned. Live on chain, will never resolve to a peer, so "try later" would be a lie. */
  | {readonly kind: 'reserved'}
  /** We could not look. Must never be shown as "unclaimed" — that would libel a real identity. */
  | {readonly kind: 'unavailable'}

/**
 * Look up `nameKey` — the padded 32-byte canonical handle from `classifyPeerInput`.
 *
 * `unavailable` and **not** `unclaimed` on any read failure, deliberately: the two lead the user to
 * opposite actions — retry later, versus "this name is yours to take" — and this code is in no position
 * to claim a name is free.
 */
export const resolveHandle = async (nameKey: Uint8Array): Promise<HandleResolution> => {
  const {decodeHandle} = await import('@pnyx/contract-client/handle')
  const decoded = decodeHandle(nameKey)
  if (!decoded.ok) {
    // Not a name this client will render, so not one it will look up either — the same gate the read
    // side applies, on the way in.
    logger.debug('handle lookup refused a non-canonical name', {origin: ORIGIN, reason: decoded.reason})
    return {kind: 'unclaimed'}
  }
  const canonical = canonicalizeHandle(decoded.display)
  const facts = await readHandleFacts(canonical)
  if (facts === undefined) return {kind: 'unavailable'}
  if (facts === null) return {kind: 'unclaimed'}
  if (facts.burned || facts.banned) return {kind: 'reserved'}
  if (facts.owner === undefined) return {kind: 'unclaimed'}

  const pnyxId = encodePnyxId(facts.owner)
  // The holder's own row decides the *label*, never the input. A row that names something else means
  // they hold this name without displaying it — reachable, unnamed.
  const {resolveIdentityRow} = await import('./identity-row')
  const lookup = await resolveIdentityRow(pnyxId)
  if (lookup.kind !== 'row') {
    // Owned by an identity whose row we could not read. Still routable — the owner is not in doubt — so
    // this is `held` without a label rather than a failure.
    logger.debug('handle owner’s row was unreadable; routing without a label', {origin: ORIGIN, kind: lookup.kind})
    return {kind: 'held', pnyxId, displayHandle: undefined}
  }
  const validity = handleValidity(facts, lookup.row.name, facts.owner)
  return {
    kind: 'held',
    pnyxId,
    displayHandle: validity.kind === 'valid' ? validity.display : undefined,
  }
}
