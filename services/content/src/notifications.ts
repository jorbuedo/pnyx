// Push notifications, content-service side (plan phase 4 item 12).
//
// Forum events produce NotificationIntents; each intent fans out to the recipient
// subject's registered devices through a PushSender. Until a Firebase project exists
// (FIREBASE_SERVICE_ACCOUNT env), the active sender only logs — everything up to the FCM
// call is real and unit-tested. Intents carry persona labels only; the recipient subject
// stays server-side (it selects the devices, it never rides in the payload).
import { neverThrows, noRealtime, type RealtimeEvent, type RealtimePublisher } from './realtime.js';
import type { ContentStore, Post, Proposal } from './store.js';

export type NotificationKind = 'post-reply' | 'new-proposal' | 'poll-result' | 'dm-message' | 'dm-invite';

type IntentBase = {
  /** Recipient account (the JWT subject, i.e. `pnyx_id`) — used for device lookup only. */
  readonly subjectAddress: string;
  /** Flat string map — FCM data messages require string values. Includes title/body. */
  readonly payload: Record<string, string>;
};

/**
 * A union rather than one shape with an optional circle: a DM belongs to no circle, and an empty
 * string standing in for one would ride into the realtime signal as if it were an id.
 */
export type NotificationIntent =
  | (IntentBase & {
      readonly kind: 'post-reply' | 'new-proposal' | 'poll-result';
      /** Circle id (communities in UI copy). */
      readonly communityId: string;
    })
  | (IntentBase & {
      /**
       * ⚠️ **Carries no conversation id and no preview, and cannot.** The relay stores MLS ciphertext
       * it has no key for, and naming the conversation would hand the who-talks-to-whom graph to FCM
       * — a weaker place to put it than our own socket, which omits it for the same reason.
       */
      readonly kind: 'dm-message' | 'dm-invite';
    });

/**
 * The Android channel a kind is displayed on.
 *
 * ⚠️ **The channel is the only thing that survives Android drawing the notification itself.** A
 * `notification` payload is displayed by the OS without the app; on resume the client imports whatever
 * is still in the tray, and notifee's view of an OS-drawn notification carries **no data** — so a DM
 * row arrived with no `kind`, no conversation, and no way for the app to recognise or clear it.
 * `channelId` is visible where the data is not.
 *
 * `undefined` leaves the client's manifest default in place, which is right for every other kind.
 */
export const channelForKind = (kind: NotificationKind): string | undefined =>
  kind === 'dm-message' || kind === 'dm-invite' ? 'pnyx_dm' : undefined

/** Whether an intent belongs to a circle, which decides what the senders may put in `data`. */
export const circleOf = (intent: NotificationIntent): string | undefined =>
  'communityId' in intent ? intent.communityId : undefined;

/** The seam in front of FCM; see push.ts / push-worker.ts for the implementations. */
export type PushSender = {
  readonly name: string;
  send(fcmToken: string, intent: NotificationIntent): Promise<void>;
};

/**
 * A token the push provider says is dead, so the install is gone.
 *
 * Part of the sender *contract* rather than of one implementation: the fan-out has to tell "forget
 * this token" apart from "try again later", and it lives here so a sender can throw it without the
 * contract module importing an implementation.
 */
export class UnregisteredDeviceError extends Error {
  constructor(readonly fcmToken: string) {
    super('the push provider reports this token is no longer registered');
    this.name = 'UnregisteredDeviceError';
  }
}

export type Notifier = {
  /** New post: a reply notifies the parent post's author. */
  postCreated(circleId: string, post: Post, authorSubject: string): Promise<NotificationIntent[]>;
  /** New proposal: notifies every circle member except the author. */
  proposalCreated(circleId: string, proposal: Proposal, authorSubject: string): Promise<NotificationIntent[]>;
  /**
   * Vote landed: notifies the proposal author with the updated tally. (The spike has no
   * poll-close lifecycle yet, so "poll result" is interpreted as every tally movement;
   * a later pass narrows this to poll close.)
   */
  voteCast(circleId: string, proposal: Proposal, voterSubject: string): Promise<NotificationIntent[]>;
  /**
   * A DM arrived for `recipientSubject` — a message in a conversation, or an invite to a new one.
   *
   * Both transports come from one place here, as they do for every other kind: the socket updates an
   * app that is open, the push wakes one that is not. The DM routes used to publish the socket signal
   * themselves and send no push at all, so a closed app learned nothing until someone opened it.
   */
  dmArrived(recipientSubject: string, kind: 'dm-message' | 'dm-invite'): Promise<NotificationIntent[]>;
};

const preview = (text: string, max = 120): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);

/**
 * Turn an intent into the socket signal for the same recipient.
 *
 * The two transports share one recipient resolution on purpose: push wakes a closed app, the socket
 * updates an open one, and deriving both from the same intents means they cannot disagree about who
 * cares. The signal carries ids only — the client refetches through the authenticated REST endpoints
 * (see `realtime.ts`).
 */
const signalFor = (intent: NotificationIntent): RealtimeEvent => {
  // Positive checks per kind: excluding the DM arms narrows `intent.kind` but not `intent`, so the
  // circle arms have to be matched rather than left over.
  if (intent.kind === 'post-reply') {
    return { kind: 'community-changed', communityId: intent.communityId };
  }
  if (intent.kind === 'new-proposal' || intent.kind === 'poll-result') {
    return {
      kind: 'proposal-changed',
      communityId: intent.communityId,
      proposalId: intent.payload.proposalId ?? '',
    };
  }
  return { kind: 'dm-waiting' };
};

export const createNotifier = (
  store: ContentStore,
  sender: PushSender,
  log: (message: string) => void,
  publisher: RealtimePublisher = noRealtime,
): Notifier => {
  // Same guarantee the router applies: a wake that throws must not fail the post it accompanies.
  const realtime = neverThrows(publisher, log);
  const deliver = async (intents: NotificationIntent[]): Promise<NotificationIntent[]> => {
    for (const intent of intents) {
      // Before the device fan-out: an app that is open should update now rather than after a push
      // round trip, and a recipient with no registered device still gets the signal.
      const signal = signalFor(intent);
      if (signal.kind !== 'proposal-changed' || signal.proposalId !== '') {
        await realtime.publish(intent.subjectAddress, signal);
      }
      const devices = await store.listDevices(intent.subjectAddress);
      if (devices.length === 0) {
        log(`notify ${intent.kind}: recipient has no registered devices`);
        continue;
      }
      // ⚠️ Each send is an *external* subrequest, capped at 50 per invocation on the free plan —
      // twenty times tighter than the 1000 that governs the DO fan-out above, and this loop is
      // members × devices. Past that the sends throw, get caught below, and the notification is
      // partially delivered with only a log line. Verified 2026-08-06; see mobile-shell-plan item 11.
      for (const device of devices) {
        try {
          await sender.send(device.fcmToken, intent);
        } catch (error) {
          // A token the provider calls dead is forgotten rather than retried forever: the install is
          // gone, so every future notification for this subject would otherwise pay for it. Any other
          // failure is transient as far as we can tell — logged, token kept.
          if (error instanceof UnregisteredDeviceError) {
            await store.removeDevice(device.fcmToken).catch(() => {});
            log(`notify ${intent.kind}: dropped an unregistered device token`);
            continue;
          }
          log(
            `notify ${intent.kind}: send via ${sender.name} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
    return intents;
  };

  return {
    postCreated: async (circleId, post, authorSubject) => {
      if (!post.parentId) {
        return [];
      }
      const parent = await store.getPost(post.parentId);
      if (!parent) {
        return [];
      }
      const parentSubject = await store.findSubjectByPersona(circleId, parent.author);
      if (!parentSubject || parentSubject === authorSubject) {
        return []; // self-replies notify nobody
      }
      return deliver([
        {
          subjectAddress: parentSubject,
          communityId: circleId,
          kind: 'post-reply',
          payload: {
            title: `${post.author} replied`,
            body: preview(post.body),
            postId: post.id,
            parentId: post.parentId,
            author: post.author,
          },
        },
      ]);
    },
    proposalCreated: async (circleId, proposal, authorSubject) => {
      const members = await store.listMemberSubjects(circleId);
      return deliver(
        members
          .filter((subject) => subject !== authorSubject)
          .map((subject) => ({
            subjectAddress: subject,
            communityId: circleId,
            kind: 'new-proposal' as const,
            payload: {
              title: `New proposal: ${preview(proposal.title, 80)}`,
              body: preview(proposal.body || `by ${proposal.author}`),
              proposalId: proposal.id,
              author: proposal.author,
            },
          })),
      );
    },
    voteCast: async (circleId, proposal, voterSubject) => {
      const authorSubject = await store.findSubjectByPersona(circleId, proposal.author);
      if (!authorSubject || authorSubject === voterSubject) {
        return []; // votes on your own proposal by yourself notify nobody
      }
      return deliver([
        {
          subjectAddress: authorSubject,
          communityId: circleId,
          kind: 'poll-result',
          payload: {
            title: `Poll update: ${preview(proposal.title, 80)}`,
            body: `yes ${proposal.tally.yes} · no ${proposal.tally.no}`,
            proposalId: proposal.id,
            yes: String(proposal.tally.yes),
            no: String(proposal.tally.no),
          },
        },
      ]);
    },
    dmArrived: async (recipientSubject, kind) =>
      deliver([
        {
          subjectAddress: recipientSubject,
          kind,
          payload: {
            title: kind === 'dm-invite' ? 'New conversation' : 'New message',
            body:
              kind === 'dm-invite' ? 'Someone started a conversation with you.' : 'You have a new direct message.',
            // The client's nav key (`parseScreenTarget`). The inbox, not a thread: a thread would need
            // the conversation id this deliberately does not carry.
            screen: 'dm',
          },
        },
      ]),
  };
};
