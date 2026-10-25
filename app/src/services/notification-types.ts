/**
 * Push notification types.
 */

export enum Trigger {
  /** FCM / remote push notification (per-token) — generic catch-all */
  Push = 'push',
  /** Blockchain transaction notification (send/receive/swap confirmation) */
  Transaction = 'transaction',
  /** FCM broadcast topic — pnyx-campaigns announcements */
  Campaigns = 'campaigns',
  /** A direct message or an invitation to one. */
  DirectMessage = 'dm',
  /** Circle activity: a reply, a new proposal, a poll that closed. */
  Forum = 'forum',
}

export type Group = 'push' | 'tx' | 'campaigns' | 'dm' | 'forum'

export const triggerGroups: Record<Trigger, Group> = {
  [Trigger.Push]: 'push',
  [Trigger.Transaction]: 'tx',
  [Trigger.Campaigns]: 'campaigns',
  [Trigger.DirectMessage]: 'dm',
  [Trigger.Forum]: 'forum',
}

/**
 * `data.kind` → the category a user can switch off, for every kind the content service sends
 * (`services/content/src/notifications.ts` → `NotificationKind`).
 *
 * ⚠️ **A kind with no entry here lands in {@link Trigger.Push}, which no setting governs.** That is
 * the right default — a category nobody can see is worse than none — but it means adding a kind to
 * the service without adding it here quietly makes it unswitchable. Kept in step with that union.
 */
const TRIGGER_BY_KIND: Readonly<Record<string, Trigger>> = {
  'dm-message': Trigger.DirectMessage,
  'dm-invite': Trigger.DirectMessage,
  'post-reply': Trigger.Forum,
  'new-proposal': Trigger.Forum,
  'poll-result': Trigger.Forum,
}

/** The category this payload belongs to, or `undefined` when its kind names none. */
export function triggerForKind(data: Record<string, unknown> | undefined): Trigger | undefined {
  const kind = data?.kind
  return typeof kind === 'string' ? TRIGGER_BY_KIND[kind] : undefined
}

/** Typed deep-link targets for push notification navigation, ordered high → low likelihood. */
export enum PushNavigationTarget {
  /** Main home screen. Route: /home */
  Home = 'home',
  /** Full transaction history list. Route: /transactions */
  TransactionHistory = 'transaction_history',
  /**
   * Single transaction detail. Route: /transactions/transaction/[hash].
   * Requires data.hash. Optional data.txType + data.chainId let the detail
   * screen render the correct title and chain context (otherwise falls back
   * to the generic "Transaction Details" label).
   */
  TransactionDetail = 'transaction_detail',
  /** Portfolio overview — legacy target, lands on /home. */
  Portfolio = 'portfolio',
  /** Specific asset detail. Route: /portfolio/[tokenId] — requires data.tokenId */
  PortfolioAsset = 'portfolio_asset',

  /** Staking hub. Route: /staking */
  Staking = 'staking',
  /** Single staking pool detail. Route: /staking/[poolId] — requires data.poolId */
  StakingPool = 'staking_pool',
  /** Earn / yield products — legacy target, lands on /home. */
  Earn = 'earn',
  /** Governance hub. Route: /governance */
  Governance = 'governance',
  /** Single DRep detail. Route: /governance/drep/[id] — requires data.id */
  GovernanceDrep = 'governance_drep',

  /** DEX swap screen. Route: /swap */
  Swap = 'swap',

  /** Token list. Route: /tokens */
  Tokens = 'tokens',
  /** Single token detail. Route: /tokens/[tokenId] — requires data.tokenId */
  TokenDetail = 'token_detail',
  /** NFT gallery. Route: /nfts */
  Nfts = 'nfts',
  /** Single NFT detail. Route: /nfts/[policyId]/[assetName] — requires data.policyId + data.assetName */
  NftDetail = 'nft_detail',

  /** Receive funds screen. Route: /receive */
  Receive = 'receive',
  /** Direct messages. Route: /community, where the inbox pane lives. */
  Dm = 'dm',
  /** In-app notification center. Route: /notifications */
  Notifications = 'notifications',
  /** App settings. Route: /settings */
  Settings = 'settings',
  /** Wallet management. Route: /settings/wallet-selection */
  WalletManager = 'wallet_manager',
}

/** Payload `data.screen` values that classify a push as {@link Trigger.Transaction}. */
export const TRANSACTION_SCREENS = new Set<string>([
  PushNavigationTarget.TransactionDetail,
  PushNavigationTarget.TransactionHistory,
])

const normalizeKey = (s: string): string => s.toLowerCase().replace(/[_\s-]+/g, '')

const _pushNavIndex: ReadonlyMap<string, PushNavigationTarget> = new Map(
  Object.values(PushNavigationTarget).map((v) => [normalizeKey(v), v]),
)

/**
 * Accepts the canonical snake_case enum value plus liberal aliases
 * (camelCase, kebab-case, mixed) — backends have shipped mixed casings for the
 * same target and the dispatcher must not silently drop those.
 */
export function parseScreenTarget(value: unknown): PushNavigationTarget | undefined {
  if (typeof value !== 'string') return undefined
  return _pushNavIndex.get(normalizeKey(value))
}

/**
 * djb2-variant hash → stable numeric id for notification dedup.
 * Both the FCM foreground/tap path and the iOS notification-center
 * sweep must produce the same id for a given messageId string.
 */
export function idFromString(source: string | undefined): number {
  if (!source) return Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
  let hash = 0
  for (let i = 0; i < source.length; i++) {
    hash = (Math.imul(31, hash) + source.charCodeAt(i)) | 0
  }
  return Math.abs(hash) || Math.floor(Math.random() * Number.MAX_SAFE_INTEGER)
}

export type PushEvent = {
  readonly id: number
  readonly date: string // ISO 8601
  readonly isRead: boolean
  readonly title: string
  readonly body: string
  readonly data: Record<string, unknown>
  readonly trigger: Trigger
}

export type NotificationConfig = {
  readonly [Trigger.Push]: {readonly notify: boolean}
  readonly [Trigger.Transaction]: {readonly notify: boolean}
  readonly [Trigger.Campaigns]: {readonly notify: boolean}
  readonly [Trigger.DirectMessage]: {readonly notify: boolean}
  readonly [Trigger.Forum]: {readonly notify: boolean}
}

/**
 * On until told otherwise, and merged over whatever is stored (`notification-storage.ts`) so a
 * config written before a category existed reads as on rather than as `undefined` — which
 * `shouldNotify` would treat as off, silently muting a category nobody switched off.
 */
export const defaultNotificationConfig: NotificationConfig = {
  [Trigger.Push]: {notify: true},
  [Trigger.Transaction]: {notify: true},
  [Trigger.Campaigns]: {notify: true},
  [Trigger.DirectMessage]: {notify: true},
  [Trigger.Forum]: {notify: true},
}

/**
 * Kinds whose inbox row the app builds itself, from state, rather than from a push.
 *
 * ⚠️ **A DM push cannot name its sender** (`services/content/src/notifications.ts` says why), so its
 * row is reconciled from the unread conversations instead — see `dm-notification-rows`. Every push
 * path must therefore leave these alone: the background handler, the notification-centre sweep and
 * the foreground display. When they did not, a DM produced two rows — the generic "New message" the
 * push carried *and* the named one reconciliation wrote — with the generic one landing last, after
 * the reconciliation that was meant to replace it.
 *
 * The OS banner is unaffected: this governs the in-app inbox only.
 */
export const LOCALLY_RECONCILED_KINDS: ReadonlySet<string> = new Set(['dm-message', 'dm-invite'])

/** Does the app own this notification's inbox row, rather than the push that delivered it? */
export function isLocallyReconciled(data: Record<string, unknown> | undefined): boolean {
  const kind = data?.kind
  return typeof kind === 'string' && LOCALLY_RECONCILED_KINDS.has(kind)
}
