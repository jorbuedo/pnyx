/**
 * Accepting incoming conversations: the recipient half of `dm-start.ts`.
 *
 * Without this a peer can invite us and we never join — every message they send arrives
 * undecryptable, and the thread shows "no secure session on this device". It is the mirror of
 * starting a conversation and just as necessary.
 *
 * The order is forced by what is destructive:
 *
 * 1. `listWelcomes` does **not** delete (changed 2026-09-01). A Welcome is redelivered until it is
 *    acked, so a pass that dies part-way costs a retry rather than the invitation. ⚠️ The price is
 *    that a Welcome can be seen twice, and joining twice would replace a live ratchet with a fresh
 *    one — hence the group-state guard below, which skips the join and acks anyway.
 * 2. Match the Welcome to one of our published KeyPackages by its **ref** — the inviter sealed the
 *    group secrets to `makeKeyPackageRef(ourPackage)`, so only that private half opens it.
 * 3. Join, then persist group state, and only then forget the private half. Forgetting first would
 *    leave a crash between the two with an unjoinable group and no way back.
 *
 * A Welcome we cannot match is logged and dropped, not retried: the matching package is gone (a
 * reinstall, a cleared store), and no amount of retrying brings it back. The peer has to invite
 * again, which is the honest outcome.
 *
 * A *record* we cannot open is forgotten for the same reason — see {@link DmRecordUnreadableError}
 * for the key change that orphaned a batch of them. The pruning is deliberately here rather than at
 * sign-in: a failed open costs a real decrypt attempt each, and the pool hook's own doc explains why
 * that work does not belong on the login path. This runs only when a Welcome is actually waiting,
 * which is the one moment the records are needed and the only moment their absence costs anything.
 *
 * @module
 */

import {Effect} from 'effect'
import {logger} from '../logger'
import {dmApi} from './dm-api'
import {rememberDmConversation} from './dm-conversations'
import {chooseGroup} from './dm-group-choice'
import {
  decodeDmKeyPackageRecord,
  decodeDmState,
  dmCiphersuite,
  dmGroupIdOf,
  encodeDmState,
  joinDmGroup,
  keyPackageRef,
  welcomeRecipientRefs,
} from './dm-mls'
import {
  archiveGroupState,
  clearRepairPending,
  deriveDmStoreKey,
  forgetPrivateHalf,
  listPrivateHalfIds,
  loadGroupState,
  loadPrivateHalf,
  repairIsPending,
  saveGroupState,
} from './dm-session'

const ORIGIN = 'dm-invites'

const run = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => Effect.runPromise(effect as Effect.Effect<A, never>)

/**
 * Is this a record that will never open, as opposed to a read that happened to fail?
 *
 * `Effect.runPromise` rejects with a `FiberFailure` wrapping the error, so the tag is matched on the
 * stringified failure rather than with `instanceof` — the class is not what crosses that boundary.
 */
const isUnreadableRecord = (error: unknown): boolean => String(error).includes('DmRecordUnreadableError')

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

export type DmInviteInput = {
  readonly token: string
  readonly forumRoot: Uint8Array
  readonly network: string
}

/**
 * Take every pending Welcome and join the groups they invite us to.
 *
 * Returns the conversation ids joined — empty is the normal steady state. Never throws: a failure
 * here degrades DMs, and callers are background hooks with nowhere useful to surface a rejection.
 */
/**
 * Tell the server to stop handing out packages we can no longer open.
 *
 * Never throws and never blocks the join: the invites this pass already accepted are the product,
 * and an unreachable service simply means the same ids are retired on the next drain — they are
 * still in the local index right up until `forgetPrivateHalf` succeeds, and pruned again after.
 */
const ackWelcomes = async (token: string, ids: readonly string[]): Promise<void> => {
  if (ids.length === 0) return
  try {
    const {acked} = await dmApi.ackWelcomes(token, ids)
    logger.debug('dm invite: welcomes acked', {origin: ORIGIN, asked: ids.length, acked})
  } catch (error) {
    // Safe to fail: an unacked Welcome is simply redelivered, and the guard above turns the second
    // sighting into an ack rather than a second join.
    logger.warn('dm invite: could not ack welcomes; they will be redelivered', {
      origin: ORIGIN,
      count: ids.length,
      error: String(error),
    })
  }
}

const retirePrunedPackages = async (token: string, ids: readonly string[]): Promise<void> => {
  if (ids.length === 0) return
  try {
    const {retired, available} = await dmApi.retireKeyPackages(token, ids)
    logger.info('dm invite: retired key packages we can no longer open', {
      origin: ORIGIN,
      asked: ids.length,
      retired,
      available,
    })
  } catch (error) {
    logger.warn('dm invite: could not retire unopenable key packages', {
      origin: ORIGIN,
      count: ids.length,
      error: String(error),
    })
  }
}

export const acceptPendingInvites = async (input: DmInviteInput): Promise<readonly string[]> => {
  const joined: string[] = []
  try {
    const welcomes = await dmApi.listWelcomes(input.token)
    if (welcomes.length === 0) {
      // Not silent: "nothing waiting" and "the drain never ran" are different facts, and telling
      // them apart from outside once cost a diagnosis — a thread reading "no secure session on this
      // device yet" with nothing in the log between the drain starting and it returning.
      logger.debug('dm invite: nothing waiting', {origin: ORIGIN})
      return joined
    }
    logger.info('dm invite: taking welcomes', {origin: ORIGIN, count: welcomes.length})

    const cs = await run(dmCiphersuite())
    const storeKey = await run(deriveDmStoreKey(input.forumRoot))
    const candidateIds = await run(listPrivateHalfIds())
    // Ids forgotten below. Their public halves are still claimable on the server until they are
    // retired, and a peer who claims one gets an invite that can never be accepted.
    const pruned: string[] = []

    // Ref → package id, computed once for all Welcomes in this batch.
    const refs: {id: string; ref: Uint8Array}[] = []
    for (const id of candidateIds) {
      try {
        const stored = await run(loadPrivateHalf(storeKey, id))
        if (stored === undefined) continue
        const record = await run(decodeDmKeyPackageRecord(stored))
        refs.push({id, ref: await run(keyPackageRef(record.publicPackage, cs))})
      } catch (error) {
        // ⚠️ A record that cannot be *opened* is dead, not merely unavailable: the key that sealed it
        // is unrecoverable, so every future drain would retry it and log the same failure. Forgetting
        // it is the only recovery, and it costs nothing that was not already lost — see
        // `DmRecordUnreadableError` for the change that orphaned these.
        if (isUnreadableRecord(error)) {
          logger.info('dm invite: forgetting a key package record that can never be opened', {
            origin: ORIGIN,
            id,
          })
          const forgotten = await run(forgetPrivateHalf(id))
            .then(() => true)
            .catch((cause: unknown) => {
              logger.warn('dm invite: could not forget an unreadable key package record', {
                origin: ORIGIN,
                id,
                error: String(cause),
              })
              return false
            })
          // Only retire what we actually let go of: a local delete that failed leaves the record in
          // play, and withdrawing its public half would strand a package we can still open.
          if (forgotten) pruned.push(id)
          continue
        }
        // Anything else — a failed storage read, a decode bug — may succeed next time, so the record
        // stays and only this pass skips it.
        logger.warn('dm invite: key package record skipped for this pass', {origin: ORIGIN, id, error: String(error)})
      }
    }

    // Acked only after the group state is durably written. Anything left unacked is redelivered,
    // which is the entire point of the two-phase take.
    const settled: string[] = []

    for (const welcome of welcomes) {
      try {
        const existing = await run(loadGroupState(storeKey, welcome.convId))
        const wanted = await run(welcomeRecipientRefs(welcome.welcome))
        const match = refs.find((candidate) => wanted.some((ref) => bytesEqual(ref, candidate.ref)))

        /**
         * ⚠️ **Having a group is no longer a reason to ignore a Welcome.**
         *
         * It used to be: any Welcome for a conversation we already held was treated as a redelivery
         * and acked unjoined. That is right for an actual redelivery and wrong for the case that
         * matters — a peer *repairing* a conversation whose two sides had ended up in different
         * groups. Their repair Welcome was dropped, so the break was unfixable from their side.
         *
         * The two are distinguishable without guessing: a redelivery was sealed to a KeyPackage we
         * consumed on the first join, so its private half is gone and `match` is undefined. A repair
         * claimed a *fresh* package, so we still hold its half. That is the test below.
         */
        if (match === undefined && existing !== undefined) {
          logger.debug('dm invite: redelivery of a Welcome we already joined, acking without re-joining', {
            origin: ORIGIN,
            convId: welcome.convId,
          })
          settled.push(welcome.id)
          continue
        }
        if (match === undefined) {
          // The package this was sealed to is gone, and retrying cannot bring it back — so this one
          // *is* acked, or it would be redelivered for ever. The peer must invite again.
          logger.warn('dm invite dropped: no matching key package', {
            origin: ORIGIN,
            convId: welcome.convId,
          })
          settled.push(welcome.id)
          continue
        }
        const stored = await run(loadPrivateHalf(storeKey, match.id))
        if (stored === undefined) continue
        const record = await run(decodeDmKeyPackageRecord(stored))
        const state = await run(joinDmGroup(welcome.welcome, record, welcome.ratchetTree, cs))

        /**
         * Which group survives, when we already had one.
         *
         * A Welcome does not expose its group id before the join — `GroupInfo` is encrypted to the
         * joiner — so the comparison happens after, which is harmless: joining writes nothing until
         * the line below.
         *
         * ⚠️ **The rule differs depending on whether we are also repairing**, and it has to, or the
         * two cases break each other. One side repairing: adopt, unconditionally, because our group
         * is the broken one they are fixing. Both sides repairing at once: adopting each other's
         * just swaps the groups and leaves us as far apart as before — so the lower group id wins,
         * a rule both sides compute identically from bytes they both hold.
         */
        if (existing !== undefined) {
          const ourState = await run(decodeDmState(existing))
          const repairing = await run(repairIsPending(welcome.convId))
          const choice = chooseGroup(dmGroupIdOf(ourState), dmGroupIdOf(state), repairing)
          if (choice !== 'adopt') {
            logger.info(
              choice === 'duplicate'
                ? 'dm invite: a Welcome for the group we are already in'
                : 'dm invite: kept our own repair, ours sorts first',
              {origin: ORIGIN, convId: welcome.convId, repairing},
            )
            settled.push(welcome.id)
            continue
          }
          logger.info('dm invite: adopting the peer’s group, replacing ours', {
            origin: ORIGIN,
            convId: welcome.convId,
            repairing,
          })
          // Kept for the changeover: messages the peer sent in the old group before this Welcome
          // are still valid and still arriving.
          await run(archiveGroupState(storeKey, welcome.convId, existing))
          await run(clearRepairPending(welcome.convId))
        }

        // State first, then release the package — a crash between them must not strand the group.
        await run(saveGroupState(storeKey, welcome.convId, encodeDmState(state)))
        await run(forgetPrivateHalf(match.id))
        // The Welcome is the only place the peer's id arrives for a conversation we did not start.
        await rememberDmConversation(input.forumRoot, {
          convId: welcome.convId,
          peer: welcome.sender,
          lastMessageAt: welcome.createdAt,
        })
        settled.push(welcome.id)
        joined.push(welcome.convId)
      } catch (error) {
        // Deliberately NOT acked: a join that threw may succeed next time, and the whole reason the
        // take stopped being destructive is so that this costs a retry rather than the invitation.
        logger.error('dm invite failed to join', {origin: ORIGIN, convId: welcome.convId, error})
      }
    }

    await ackWelcomes(input.token, settled)

    await retirePrunedPackages(input.token, pruned)
    logger.info('dm invite: drain finished', {
      origin: ORIGIN,
      took: welcomes.length,
      joined: joined.length,
      // A non-zero gap is the unjoinable case, and it is the number worth seeing.
      dropped: welcomes.length - joined.length,
    })
  } catch (error) {
    logger.warn('dm invite poll failed', {origin: ORIGIN, error: String(error)})
  }
  return joined
}
