// The realtime plane: tell a connected client that something it is looking at has changed.
//
// Replaces the 5-second polls (`useCommunityView` while a chain ref is pending, `useDmKeyPackagePool`
// for invites), whose own comment said the honest thing — polling was the mechanism because a Worker
// over D1 has no push primitive. A Durable Object is that primitive.
//
// **Signals, not content.** An event names what changed and gives the ids needed to refetch it
// narrowly; it never carries a post body or a DM. Three things follow, and they are the reason the
// design is this shape rather than a message log:
//
//  1. **A missed event costs nothing.** The client refetches on connect, so reconnecting *is* the
//     catch-up — there is no cursor, no replay, and no "did I miss one" to get wrong. DM messages are
//     a drain-on-fetch queue server-side, so nothing is lost by a socket that was down.
//  2. **The DO holds no plaintext**, so the realtime plane is not a new place a DM can leak from. It
//     sees that something happened for one identity, which is what that identity's own socket is for.
//  3. **The client stays the authority on what it renders**, reached through the same authenticated
//     REST endpoints as before. The socket cannot inject content, only prompt a read.
//
// One hub per subject rather than per circle: a phone should hold one socket, not one per community.
// The fan-out cost is one wake per recipient, and the recipient resolution already exists — the same
// `NotificationIntent`s that drive push drive this, so the two transports cannot disagree about who
// cares about an event.

/** What changed. Deliberately coarse: the client refetches, so precision buys nothing. */
export type RealtimeEvent =
  | { readonly kind: 'community-changed'; readonly communityId: string }
  | { readonly kind: 'proposal-changed'; readonly communityId: string; readonly proposalId: string }
  | { readonly kind: 'chain-settled'; readonly communityId: string }
  | { readonly kind: 'dm-waiting' };

export type RealtimePublisher = {
  /** Wake `subject`'s connected devices. Never throws: a signalling failure must not fail a write. */
  publish(subject: string, event: RealtimeEvent): Promise<void>;
};

/** No realtime plane. The Node composition has no Durable Objects, so dev keeps polling. */
export const noRealtime: RealtimePublisher = { publish: async () => {} };

/**
 * Make a publisher's "never throws" contract true rather than assumed.
 *
 * Applied once where a publisher enters the request handler, so no call site can forget it: a signal is
 * a convenience and the write it accompanies is the product — a post that 500s because a hub was
 * unreachable would be the tail wagging the dog. The built-in publisher already catches; this is what
 * stops that from being a property of one implementation.
 */
export const neverThrows = (publisher: RealtimePublisher, log: (message: string) => void): RealtimePublisher => ({
  publish: async (subject, event) => {
    try {
      await publisher.publish(subject, event);
    } catch (error) {
      log(`publish ${event.kind} threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  },
});

/**
 * The wire frame. Versioned because a client that predates a new event kind must be able to ignore it
 * rather than misread it — and an app update lags a Worker deploy by however long a store review takes.
 */
export type RealtimeFrame = { readonly v: 1; readonly event: RealtimeEvent };

export const encodeFrame = (event: RealtimeEvent): string => JSON.stringify({ v: 1, event } satisfies RealtimeFrame);

/**
 * Parse a frame, or `undefined` for anything we do not understand.
 *
 * Unknown kinds are dropped rather than guessed at: a client that treats an unrecognised event as "some
 * refetch" would fire whole-view reloads for things it has no screen for.
 */
export const decodeFrame = (raw: string): RealtimeEvent | undefined => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const { v, event } = parsed as { v?: unknown; event?: unknown };
  if (v !== 1 || typeof event !== 'object' || event === null) return undefined;
  const e = event as { kind?: unknown; communityId?: unknown; proposalId?: unknown };
  const str = (value: unknown) => (typeof value === 'string' && value.length > 0 && value.length <= 80 ? value : undefined);
  switch (e.kind) {
    case 'dm-waiting':
      return { kind: 'dm-waiting' };
    case 'community-changed':
    case 'chain-settled': {
      const communityId = str(e.communityId);
      return communityId === undefined ? undefined : { kind: e.kind, communityId };
    }
    case 'proposal-changed': {
      const communityId = str(e.communityId);
      const proposalId = str(e.proposalId);
      return communityId === undefined || proposalId === undefined
        ? undefined
        : { kind: 'proposal-changed', communityId, proposalId };
    }
    default:
      return undefined;
  }
};
