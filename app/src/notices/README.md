# Notices

Route-indexed attention-dot registry. Lets any nav surface (tab bar button, settings row, menu row, dashboard icon, …) display a red "there's something here" dot without each surface having to know what the signal was.

## Why

Before this module, every attention dot was hand-wired: the dashboard's settings icon took a `showBackupIndicator` prop, which was computed from `useMnemonicBackupStatus` via a specific piece of dashboard state. Adding a second reason to light the same dot meant threading another prop through the same call chain. Adding a dot to a *different* surface meant repeating the pattern from scratch.

The registry inverts the direction: sources *publish* notices; nav surfaces *subscribe* by route.

## Anatomy

A notice is:

```ts
{
  key: string     // stable id, e.g. 'backup-pending'
  route: string   // deepest nav location the notice anchors to
  active: boolean // current state
}
```

- **`key`** lets a single source update in place without clearing and re-adding. Two sources must never share a key.
- **`route`** is where the notice *originates*, not where it appears. A notice at `/menu/airdrop` will also light up anything watching `/menu` (see Propagation).
- **`active`** is read-only from the provider's perspective — the source hook computes it each render.
- **`dismissable`** (optional) opts the notice into visit-based suppression — see Dismissal.

## Propagation

`useNoticeDot(route)` returns `true` if any active notice's route equals `route` **or** starts with `route + '/'`.

```
Notice route           useNoticeDot('/menu')   useNoticeDot('/menu/airdrop')   useNoticeDot('/settings')
/menu/airdrop          true                    true                            false
/menu                  true                    false                           false
/settings/backup       false                   false                           true
```

This means the hierarchy of dots comes for free from route structure. No parent component has to list its children's notice keys — it just watches its own route and any descendant notice automatically bubbles up.

Routes are case-sensitive. Trailing slashes on the query are tolerated (`'/settings/'` and `'/settings'` behave the same).

### A surface can own several subtrees

⚠️ **Nav order and route order are not the same thing.** `/settings/security` is reached by tapping
the Menu tab, but it does not descend from `/menu` — so a single prefix could never light the tab
that leads there, and the trail of dots started at its own destination.

`useNoticeDot` and `<NoticeDot route=… />` therefore accept an array. Which subtrees each tab owns is
`nav-routes.ts`, which is the missing edge written down once:

```ts
export const TAB_NOTICE_ROUTES = {
  id: ['/id'],
  community: ['/community', '/dm'],   // DM threads are a top-level route
  wallets: ['/wallets', '/wallet'],
  menu: ['/menu', '/settings'],       // Menu is the settings surface
}
```

A new top-level route that a tab leads to belongs there, or its dots stop at the screen they are on.

## Reading: displaying a dot

Two ways.

**Simple overlay** — drop a `<NoticeDot />` on top of an icon:

```tsx
<View style={styles.avatarWrapper}>
  <UniAvatarIcon icon="walletFilled" />
  <NoticeDot route="/settings" />
</View>
```

`NoticeDot` positions itself `absolute` top-right by default. Pass `position="static"` to place it inline in a flex row, or `style={{...}}` to nudge the absolute position.

**Custom layout** — read the hook and render whatever you want:

```tsx
const hasSettingsNotice = useNoticeDot('/settings')

return (
  <>
    {hasSettingsNotice && !otherBadge && <Badge status="error" ... />}
    {otherBadge && <UnreadBadge count={count} />}
  </>
)
```

This is how `DashboardHeader` handles the three-way mutual-exclusion between unread count, settings notice, and push-permission nudge — all three compete for the same visual slot so it keeps them in one file.

## Dismissal

Two modes:

**Default (active-until-resolved)** — dot stays visible until the source publishes `active: false`. Right for signals that *need* the user to act: backup pending, legacy migration waiting, OS-level push permission missing, unread notifications, wallet needs multichain upgrade.

**Dismissable** — source opts in via `dismissable: true`. The user visiting the anchoring screen suppresses the dot; the framework persists the dismissal to storage. The dismissal auto-clears the next time the source publishes `active: false`, so a later re-activation (the signal transitions false → true again) re-arms the dot.

This matters for soft nudges like *"you could set up biometric"* or *"there's still a NIGHT allocation you haven't claimed"* — a user who chose not to act shouldn't get pestered indefinitely, but should hear about it again if something meaningful changes (PIN re-disabled, new midnight thaw after a partial claim, etc.).

Screens at the anchoring route opt into dismissal by calling `useDismissNoticeOnFocus(key)`:

```tsx
// app/app/settings/security.tsx
useDismissNoticeOnFocus('pin-not-enabled')
useDismissNoticeOnFocus('biometric-not-enabled')
```

Non-dismissable notices ignore the focus hook (calling it is a no-op).

## Writing: adding a new source

Three steps.

**1. Write a source hook.** It should live in `src/notices/sources/` and call `useRegisterNotice(key, value)` with a stable key and the computed `{route, active}`:

```ts
// src/notices/sources/useExampleNotice.ts
import {useExampleStatus} from '../../hooks/useExampleStatus'
import {useRegisterNotice} from '../useNoticeDot'

export const useExampleNotice = (): void => {
  const {actionNeeded} = useExampleStatus()
  useRegisterNotice('example', {
    route: '/settings/example',
    active: actionNeeded,
  })
}
```

**2. Register it** in `src/notices/sources.tsx`:

```tsx
export const NoticeSources = (): null => {
  useBackupNotice()
  useExampleNotice()  // ← add here
  return null
}
```

**2b. For a varying number of notices**, use `useRegisterNoticeSet` — hooks cannot be called in a
loop, so one-per-item is driven from a single effect that also clears the ones that go away:

```ts
const keyOf = (convId: string) => `dm-unread:${convId}`   // module-level: must be stable
const routeOf = (convId: string) => `/dm/${convId}`
useRegisterNoticeSet(keyOf, routeOf, unreadConversationIds)
```

**3. Drop `<NoticeDot route="..." />`** on any nav surface that should reflect it. For the example above, the dot will fire on `/settings` and `/settings/example` automatically once anyone watches those routes — you don't have to pick a specific surface.

## Current sources

⚠️ **This table was rewritten on 2026-08-31 against the code.** It had listed eight sources; five of
them (`migration-pending`, `multichain-activation`, `pin-not-enabled`, `biometric-not-enabled`,
`push-unread`) no longer exist — they were removed with the surfaces they belonged to, and the doc
kept describing them. Anything listed here should be greppable in `sources.tsx`.

| Key | Route | Source hook | When it fires |
| --- | --- | --- | --- |
| `backup-pending:{groupId}` | `/settings/wallet-selection/{groupId}/backup` | `useBackupNotice` | One notice per wallet group that still needs backup, anchored at the Recovery Phrase row so the dot rides the whole nav path. |
| `security-settings-unseen` | `/settings/security` | `useSecuritySettingsSeenNotice` | First-run nudge to visit Security & Privacy. **Dismissable** — the source publishes `active: true` unconditionally, so the first visit settles it. |
| `push-permission-missing` | `/settings/notifications` | `usePushPermissionNotice` | Native, `pushNotifications` flag on, OS permission denied/undetermined. Suppressed during the initial async check to avoid a cold-start flash. |
| `dm-unread:{convId}` | `/dm/{convId}` | `useDmUnread` (via `DmBackgroundTasks`) | One per conversation with messages newer than this device's read marker. Registered through `useRegisterNoticeSet`. Not dismissable: reading the thread is what clears it, and that moves the marker the notice is derived from. |

### Counts stay counts

Dots are boolean. The one count in the app is the bell's unread badge (`useUnreadNotifications`),
which totals the notification centre's own unread events — deliberately **not** including unread DMs,
because tapping the bell opens a list that does not contain them. DMs lead the user through their dot
trail instead. Putting them on the bell means first putting them in the centre.

## Non-goals / what's explicitly not here

- **No counts / severities.** Dots are boolean. If we ever need numbered badges (like the push-unread count), they can live alongside notices in the same slot — see `DashboardHeader` for an example of mutual-exclusion between a count badge and a notice dot.
- **No cross-app propagation.** Notices are per-React-tree; they don't sync to the background script, other tabs, or native-side state. If a source needs that (e.g. push-notification deeplinks), the *source* handles it and the notice just reflects the result.
- **Dismissal is deliberately simple.** It's a binary flag, auto-cleared by a single false→true transition on the source. If we later need "dismiss with threshold" — e.g. re-show the midnight dot only when a *new* thaw pushes the amount past the one the user saw last time — that logic belongs in the source hook (compare current `totalRedeemable` against a stored `lastDismissedAmount`), not the framework.

## Provider placement

`NoticeProvider` is mounted in `app/_layout.tsx` **after** the providers whose state the source hooks read from (`WalletProvider`, `BackupStatusProvider`, …). If you add a source that depends on a provider lower in the tree, either move `NoticeProvider` down or split the source out.

The provider renders `<NoticeSources />` internally, so every source hook runs inside the notice context without the app layout having to know which sources exist.
