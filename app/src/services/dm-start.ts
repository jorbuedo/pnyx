/**
 * Starting a conversation: the one flow that has to get every trust decision right.
 *
 * Five steps, and the order matters:
 *
 * 1. Resolve the peer's **anchor** from their on-chain identity row.
 * 2. Claim one of their **KeyPackages** from the delivery service.
 * 3. Check that package against the anchor ({@link verifyKeyPackageAnchor}) — this is the step that
 *    makes the whole thing sound. Without it the delivery service could hand us a package it made
 *    up, join itself to the conversation, and read everything. The row exists for this check.
 * 4. Create the MLS group and add them, which produces a Welcome.
 * 5. Persist our group state **before** delivering the Welcome. If the order were reversed, the peer
 *    could join a group we have no record of and every message they send would be undecryptable.
 *
 * Every failure is a distinct, named outcome rather than a thrown blob, because the UI has to word
 * them differently: "this build has no chain access" is our problem, "they have never published" is
 * a different problem, and "the package did not match their anchor" is a security event.
 *
 * @module
 */

import {Effect} from 'effect'
import {logger} from '../logger'
import {dmApi} from './dm-api'
import {capturePermit, permitToPresent} from './dm-consent'
import {consentRefusalOf} from './dm-consent-refusal'
import {rememberDmConversation} from './dm-conversations'
import {conversationId} from './dm-crypto'
import {
  addDmMember,
  createDmGroup,
  decodeMlsKeyPackage,
  deriveMlsIdentity,
  dmCiphersuite,
  encodeDmState,
  makeDmKeyPackage,
  newDmGroupId,
  verifyKeyPackageAnchor,
} from './dm-mls'
import {
  archiveGroupState,
  deriveDmStoreKey,
  loadConversationIndex,
  loadGroupState,
  markRepairPending,
  saveGroupState,
} from './dm-session'
import {resolveIdentityRow} from './identity-row'

/**
 * Why starting a conversation failed. Each maps to different copy, and collapsing them would either
 * blame the user for our limitation or hide a security failure as a network blip.
 */
export type DmStartFailure =
  /** No chain rail on this build, so no anchor can be resolved at all. Ours, not theirs. */
  | {readonly kind: 'chain-unavailable'}
  /** The id is well-formed but no row has been published — they have not enabled DMs. */
  | {readonly kind: 'peer-not-published'}
  /** Their pool is empty. They exist and have published; their client just needs to refill. */
  | {readonly kind: 'peer-no-key-packages'}
  /**
   * A claimed package did not match the peer's on-chain anchor.
   *
   * Not a transient error — either the delivery service is substituting packages or the peer's
   * client is broken. Never retried and never worked around.
   */
  | {readonly kind: 'key-package-rejected'}
  /** The peer is us. Not a failure to report — a signal to open the notes thread. */
  | {readonly kind: 'self-conversation'}
  /**
   * The peer will not accept a conversation from us.
   *
   * ⚠️ One kind for two different refusals, deliberately: the service answers a block and a closed
   * inbox identically, so that a sender cannot learn they were blocked specifically. Splitting them
   * here would only invent a distinction the wire does not carry.
   */
  | {readonly kind: 'peer-refuses'}
  /** The peer accepts messages by permit only, and we hold none. */
  | {readonly kind: 'permit-required'}
  | {readonly kind: 'failed'; readonly cause: unknown}

export type DmStartResult =
  | {readonly ok: true; readonly convId: string}
  | {readonly ok: false; readonly failure: DmStartFailure}

export type DmStartInput = {
  readonly token: string
  /** Our own `pnyx_id` — the group id derives from the sorted pair. */
  readonly selfIdentity: string
  readonly peerIdentity: string
  readonly forumRoot: Uint8Array
  readonly network: string
  /**
   * Build a new group even though this device already holds one for the conversation.
   *
   * ⚠️ Only for repair. Adoption exists so an ordinary second start cannot claim another of the
   * peer's KeyPackages or collide a Welcome — but a conversation whose two sides have ended up in
   * *different* groups can only be fixed by replacing ours, and adoption would hand the broken one
   * straight back. The caller must have established that it is broken (see `dmFrameInfo`), not
   * merely that a message failed to open.
   */
  readonly rebuild?: boolean | undefined
}

const ORIGIN = 'dm-start'

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

const nowIso = (): string => new Date().toISOString()

/**
 * Whether this "conversation" is really a note to self.
 *
 * ⚠️ **There is no such conversation any more.** A note to self is the local scratchpad
 * (`dm-local.ts`) — no group, no service, no session. This exists so a caller that is handed its own
 * `pnyx_id` can send the user there instead of building an MLS group of one that would encrypt
 * nothing, post nothing and fetch nothing.
 */
export const isSelfConversation = (selfIdentity: string, peerIdentity: string): boolean => selfIdentity === peerIdentity

export const startDmConversation = async (input: DmStartInput): Promise<DmStartResult> => {
  // Before anything else: the steps below all describe a second party, and there
  // is not one. Reaching them with our own id would claim one of our own
  // single-use key packages and try to add us to a group we are already in.
  if (isSelfConversation(input.selfIdentity, input.peerIdentity)) {
    // Callers must route to the notes thread instead; there is no group to build for one member.
    return {ok: false, failure: {kind: 'self-conversation'}}
  }

  const convId = conversationId(input.selfIdentity, input.peerIdentity)
  try {
    // 1 + 2. Anchor first: without it the claimed package cannot be checked, and claiming consumes
    // one of the peer's single-use packages — so a claim we could never verify would waste it.
    //
    // A single row lookup, not a whole-map download with client-side filtering: the circuit
    // authenticated the write, so whatever is at the peer's row was put there by whoever knows its
    // preimage (docs/PNYX_IDENTITY_PLAN.md).
    const lookup = await resolveIdentityRow(input.peerIdentity)
    if (lookup.kind === 'unavailable') {
      return {ok: false, failure: {kind: 'chain-unavailable'}}
    }
    if (lookup.kind === 'unpublished') {
      return {ok: false, failure: {kind: 'peer-not-published'}}
    }
    const resolved = lookup.row

    const storeKey = await run(deriveDmStoreKey(input.forumRoot))

    /**
     * ⚠️ **Already ours — adopt it rather than build a second one.**
     *
     * A conversation id is derived from the two ids, not allocated, so "start a conversation with
     * this peer" names the *same* conversation every time. Starting one and leaving before sending
     * left a group on this device and a pending Welcome on the service, and the next attempt built
     * both again: it claimed another of the peer's single-use KeyPackages, then delivered a Welcome
     * whose id collides with the pending one. Each retry cost the peer a KeyPackage and answered the
     * user with a failure for a conversation that already existed.
     *
     * Adopting is also what the user asked for. They want that thread open; it is open.
     */
    const existing = await run(loadGroupState(storeKey, convId))
    /**
     * ⚠️ **State alone is not enough to adopt — the index row is the proof it completed.**
     *
     * Group state is written *before* the Welcome goes out, deliberately, so the peer can never join
     * a group we have no record of. The index row is written *after* the Welcome is accepted. So
     * state-without-a-row means the last attempt died between the two: we hold a group the peer was
     * never invited into, and adopting it would strand the conversation for good. Rebuilding is the
     * right answer there, and it is safe, because nothing on the other side joined anything.
     */
    const known = (await run(loadConversationIndex(storeKey))).some((one) => one.convId === convId)
    if (input.rebuild === true && existing !== undefined) {
      logger.info('dm start: rebuilding a conversation this device already holds, on request', {
        origin: ORIGIN,
        convId,
      })
    }
    if (existing !== undefined && !known && input.rebuild !== true) {
      logger.warn('dm start: group state exists but the conversation never completed — rebuilding', {
        origin: ORIGIN,
        convId,
      })
    }
    if (existing !== undefined && known && input.rebuild !== true) {
      await rememberDmConversation(input.forumRoot, {convId, peer: input.peerIdentity, lastMessageAt: nowIso()})
      logger.debug('dm start: adopted the conversation this device already holds', {origin: ORIGIN, convId})
      return {ok: true, convId}
    }

    const permit = await run(permitToPresent(storeKey, input.peerIdentity))
    let claimed: Uint8Array | undefined
    try {
      claimed = await dmApi.claimKeyPackage(input.token, input.peerIdentity, permit)
    } catch (error) {
      const refusal = consentRefusalOf(error)
      if (refusal !== undefined) return {ok: false, failure: {kind: refusal}}
      throw error
    }
    if (claimed === undefined) {
      return {ok: false, failure: {kind: 'peer-no-key-packages'}}
    }

    // 3. The check the identity row exists for.
    const cs = await run(dmCiphersuite())
    const peerPackage = await run(decodeMlsKeyPackage(claimed))
    if (!verifyKeyPackageAnchor(peerPackage, resolved.anchor, input.peerIdentity)) {
      return {ok: false, failure: {kind: 'key-package-rejected'}}
    }

    // 4. Our own leaf, then the group.
    const identity = await run(deriveMlsIdentity(input.forumRoot))
    const own = await run(makeDmKeyPackage(identity, input.selfIdentity, cs))
    // ⚠️ A fresh random id, not the conversation id — see `newDmGroupId`. The conversation id still
    // addresses the thread; it is no longer what the group is called.
    const created = await run(createDmGroup(await run(newDmGroupId()), own, cs))
    const invite = await run(addDmMember(created, peerPackage, cs))

    // 5. State before Welcome — see the module note.
    if (input.rebuild === true && existing !== undefined) {
      // The group we are replacing stays readable for the changeover: the peer keeps sending in it
      // until our Welcome reaches them, and those messages are valid.
      await run(archiveGroupState(storeKey, convId, existing))
      // Marks us as the side that rebuilt, which is what makes a simultaneous repair converge
      // rather than swap — see `markRepairPending`.
      await run(markRepairPending(convId))
    }
    await run(saveGroupState(storeKey, convId, encodeDmState(invite.state)))

    let delivered: {permit?: string}
    try {
      delivered = await dmApi.deliverWelcome(input.token, convId, {
        id: `${convId.slice(0, 16)}-welcome`,
        recipient: input.peerIdentity,
        welcome: invite.welcome,
        ratchetTree: invite.ratchetTree,
        permit,
      })
    } catch (error) {
      const refusal = consentRefusalOf(error)
      if (refusal !== undefined) return {ok: false, failure: {kind: refusal}}
      throw error
    }
    // ⚠️ The only copy. A permit is stateless, so the service has no record to re-issue from.
    await run(capturePermit(storeKey, input.peerIdentity, delivered.permit))
    // The index is what the inbox lists from; the server row only exists while messages are undelivered.
    await rememberDmConversation(input.forumRoot, {
      convId,
      peer: input.peerIdentity,
      lastMessageAt: nowIso(),
    })
    return {ok: true, convId}
  } catch (cause) {
    return {ok: false, failure: {kind: 'failed', cause}}
  }
}
