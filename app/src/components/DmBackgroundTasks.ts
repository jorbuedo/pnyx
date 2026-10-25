/**
 * Mounts the DM background work *below* `RealtimeProvider`.
 *
 * ⚠️ **Why this component exists at all.** These two hooks used to run inside `PnyxSessionProvider`,
 * which renders `RealtimeProvider` as its own child — so `useRealtime()` read the context *default*,
 * whose `subscribe` is a no-op returning a no-op. Nothing threw and nothing logged: invites were
 * drained only by the one-shot mount effect, so every `dm-waiting` signal and every reconnect drain
 * was dropped. A Welcome that arrived after sign-in sat on the server untaken, and the peer's
 * messages stayed undecryptable behind "This conversation has no secure session on this device yet".
 *
 * A hook that reads a context is only correct below that context's provider, and React gives no
 * warning when it is not — so this is a placement invariant, not a preference. Keep it rendered
 * inside `RealtimeProvider`.
 *
 * @module
 */

import {useDmInvites, useDmKeyPackagePool} from '../hooks/useDmKeyPackagePool'
import {useDmUnread} from '../hooks/useDmUnread'
import {usePnyxSession} from '../providers/PnyxSessionProvider'

export function DmBackgroundTasks(): null {
  const {session, forumRoot} = usePnyxSession()
  // The KeyPackage pool. The DM *anchor* is published inside signInWithMidnight instead, because it
  // needs the SIWM key which only exists there; the pool needs only the session's forumRoot.
  useDmKeyPackagePool(session)
  // Without this a peer can invite us and we never join, so every message they send arrives
  // undecryptable. `takeWelcomes` is destructive, so this has to keep draining, not fire once.
  useDmInvites(session)
  // Unread dots and the arrival toast: driven by the same signal, for the same reason — the trail
  // has to appear when the message does, not when the inbox next mounts.
  useDmUnread(session, forumRoot)
  return null
}
