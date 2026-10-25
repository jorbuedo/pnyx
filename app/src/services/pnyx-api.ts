/**
 * Typed client for the Pnyx content service (services/content REST API).
 *
 * The wire contract speaks in `circle`/`persona` terms; those identifiers are kept
 * here so the types mirror the API exactly. UI copy never surfaces them — circles
 * render as communities and personas as per-community display names
 * (docs/mobile-shell-plan.md, "UI shape").
 *
 * Auth endpoints live in `pnyx-session.ts` (SIWM sign-in owns its own error
 * taxonomy); this module covers the content plane only.
 */

import {serviceUrl} from './pnyx-session'

/**
 * On-chain mirror status for a circle / membership / proposal / vote.
 * Absent ref = chain mirroring disabled (pure content-plane mode).
 */
export type ChainRef = {
  readonly status: 'pending' | 'confirmed' | 'failed'
  readonly txId?: string
  readonly chainId?: string
  readonly error?: string
}

export type Circle = {
  /** The on-chain founder's persona commitment, hex — absent until the deploy has been settled. */
  readonly founderLeaf?: string
  /**
   * What the rail shows for this circle — one grapheme, an emoji included.
   *
   * Absent means the founder has not chosen one, and the rail falls back to the name's initial.
   */
  readonly displayChar?: string
  readonly id: string
  readonly name: string
  readonly description: string
  readonly author: string
  readonly createdAt: string
  readonly memberCount: number
  /**
   * Whether anyone may join without an invite.
   *
   * Sealed into the contract's initial state and therefore into its address, so it is fixed at
   * creation — the row reports what the deploy committed to rather than a setting anyone can change.
   */
  readonly isOpen: boolean
  /**
   * Whether this circle's contract came from the compile this build proves against.
   *
   * `outdated` is the case worth rendering: the contract still *reads* — the ledger only ever gained
   * appended fields — but its verifier keys are an older compile, so every proof against it is invalid
   * and the sponsor refuses its calls. It looks healthy and cannot be used.
   *
   * ⚠️ `unknown` is not `current`. It means the service has not resolved the digest (or the circle has
   * no contract at all), so it must not be rendered as a reassurance.
   */
  readonly template?: 'current' | 'outdated' | 'unknown'
  readonly chain?: ChainRef
}

/**
 * One requirement a gated circle admits on.
 *
 * ⚠️ **A circle carries a set of these and any one admits** — the founder's question is "who may
 * join", so a list under it is a list of groups who may. Kept as `kind` + one `param` because that
 * is what the row holds; `param` is a DRep id, a pool id, or a lovelace threshold as a decimal
 * string (never a number — a threshold in the billions of ADA must not round through a double).
 */
export type InviteRule = {readonly kind: string; readonly param: string | null}

export type Membership = {
  readonly persona: string
  readonly disclosed: boolean
  readonly joinedAt: string
  readonly chain?: ChainRef
}

export type Proposal = {
  readonly id: string
  readonly circleId: string
  readonly title: string
  readonly body: string
  readonly author: string
  readonly createdAt: string
  readonly tally: {readonly yes: number; readonly no: number}
  readonly hasVoted?: boolean
  readonly chain?: ChainRef
  readonly myVoteChain?: ChainRef | null
}

export type Post = {
  readonly id: string
  readonly circleId: string
  readonly parentId?: string
  /** Absent means the circle's default stream, not "unknown" — see the service's `Post.channelId`. */
  readonly channelId?: string
  readonly body: string
  readonly author: string
  readonly createdAt: string
}

/** A named grouping of a circle's posts. Content-layer only — never a contract. */
export type Channel = {
  readonly id: string
  readonly circleId: string
  readonly name: string
  /** What the channel is for. Absent means its creator gave none — render nothing, not a stand-in. */
  readonly description?: string
  readonly createdBy: string
  readonly createdAt: string
}

export type CircleView = {
  readonly circle: Circle
  readonly membership: Membership | null
  readonly proposals: readonly Proposal[]
  readonly posts: readonly Post[]
  /**
   * The circle's channels, in creation order.
   *
   * Optional so a build talking to a service that predates channels reads as "none" rather than
   * throwing — the default stream still renders, which is what every post there belongs to.
   */
  readonly channels?: readonly Channel[]
}

/**
 * Error for every failure mode of a content-service call.
 * `status === undefined` means the request never got an HTTP response
 * (network failure / service unreachable); otherwise it is the HTTP status
 * and `message` carries the service's `error` body when present.
 */
export class PnyxApiError extends Error {
  constructor(
    readonly status: number | undefined,
    message: string,
    override readonly cause?: unknown,
    /**
     * The parsed error body, when the service sent one.
     *
     * ⚠️ Carried because a status and a sentence are not always enough: the invite attestor
     * answers a refusal with a machine-readable `failure` naming *which* rule bit — "not
     * delegated to that DRep" against "below the threshold" — and those ask the user for
     * different things. Without this the caller could only reconstruct it by matching on prose.
     */
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'PnyxApiError'
  }

  get isNetworkError(): boolean {
    return this.status === undefined
  }
}

type RequestOptions = {
  readonly method?: 'GET' | 'POST'
  readonly token?: string
  readonly body?: unknown
}

const request = async <T>(path: string, options: RequestOptions = {}): Promise<T> => {
  const url = `${serviceUrl()}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        ...(options.token === undefined ? {} : {authorization: `Bearer ${options.token}`}),
      },
      ...(options.body === undefined ? {} : {body: JSON.stringify(options.body)}),
    })
  } catch (error) {
    throw new PnyxApiError(undefined, `content service unreachable at ${url}`, error)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    if (!response.ok) {
      throw new PnyxApiError(response.status, `request failed: ${response.status}`, error)
    }
    throw new PnyxApiError(undefined, `invalid JSON from ${path}`, error)
  }
  if (!response.ok) {
    const message = (payload as {error?: string}).error ?? `request failed: ${response.status}`
    throw new PnyxApiError(response.status, message, undefined, payload)
  }
  return payload as T
}

export const pnyxApi = {
  listCircles: () => request<{circles: Circle[]}>('/circles'),

  createCircle: (token: string, body: {name: string; description: string; persona?: string; isOpen: boolean}) =>
    request<{circle: Circle; membership: Membership}>('/circles', {
      method: 'POST',
      token,
      body,
    }),

  getCircle: (id: string, token?: string) => request<CircleView>(`/circles/${id}`, token === undefined ? {} : {token}),

  join: (token: string, circleId: string, persona?: string) =>
    request<{membership: Membership}>(`/circles/${circleId}/join`, {
      method: 'POST',
      token,
      body: {persona},
    }),

  /**
   * Drop this subject's membership row.
   *
   * ⚠️ **Un-lists; does not un-member.** Membership is a leaf in the circle's on-chain `members`
   * tree, and only `submitDeviceLeave` removes it. Call this *after* the chain half, never instead of
   * it — the reverse order takes someone off every list while they can still prove they belong.
   */
  leave: (token: string, circleId: string) =>
    request<{left: true}>(`/circles/${circleId}/leave`, {method: 'POST', token}),

  createPost: (token: string, circleId: string, body: {body: string; parentId?: string; channelId?: string}) =>
    request<{post: Post}>(`/circles/${circleId}/posts`, {method: 'POST', token, body}),

  listChannels: (token: string, circleId: string) =>
    request<{channels: Channel[]}>(`/circles/${circleId}/channels`, {token}),

  setCircleDisplayChar: (token: string, circleId: string, body: {displayChar: string}) =>
    request<{circle: Circle}>(`/circles/${circleId}/display`, {method: 'POST', token, body}),

  // ── Self-service invites ────────────────────────────────────────────────────────────────
  //
  // The circle's entry rule, and the authority the founder delegates so the service can mint a code
  // per qualifying wallet. Nothing is stocked ahead of time: the founder posts
  // `setInviteAuthority(commitment)` once, and from then on the service issues on demand.
  //
  // ⚠️ **`authorityCommitment` is what we *would* use, not proof of anything.** Whether this circle
  // actually delegated is a fact about its contract's `inviteAuthority` cell, read natively from
  // chain state — never from this response.

  /**
   * What this circle demands of a stake key, and the authority a founder would delegate to.
   *
   * `rules` is a **set** — anyone who meets *one* of them may join. `null` means no self-service
   * path; an empty array means one was configured and has no requirements left, which admits nobody.
   */
  getCircleInvitePolicy: (token: string, circleId: string) =>
    request<{rules: InviteRule[] | null; authorityCommitment: string | null}>(`/circles/${circleId}/invite-policy`, {
      token,
    }),

  /** Replace the requirements wholesale. An **empty array** closes the self-service path. */
  setCircleInvitePolicy: (token: string, circleId: string, body: {rules: InviteRule[]}) =>
    request<{rules: InviteRule[] | null; authorityCommitment?: string}>(`/circles/${circleId}/invite-policy`, {
      method: 'POST',
      token,
      body,
    }),

  /** Ask for something to sign. Server-issued, so the requester cannot mint their own. */
  requestInviteChallenge: (token: string, circleId: string) =>
    request<{nonce: string; expiresAtMs: number; payload: string}>(`/circles/${circleId}/invite-challenge`, {
      method: 'POST',
      token,
    }),

  /**
   * Redeem a signed challenge for an invite.
   *
   * The failure shapes matter to the caller: 403 with a `failure` names which rule bit, 409 means
   * the circle's founder has not turned delegation on or the circle is not on chain (their problem,
   * not the requester's), and 503 means we could not reach the chain to check, or could not mint —
   * never that they do not qualify.
   */
  claimCircleInvite: (
    token: string,
    circleId: string,
    body: {
      nonce: string
      expiresAtMs: number
      stakeAddressBech32: string
      stakeAddressHex: string
      signature: string
      key: string
    },
  ) => request<{invite: string; reissued: boolean}>(`/circles/${circleId}/invite-claim`, {method: 'POST', token, body}),

  createChannel: (token: string, circleId: string, body: {name: string; description?: string}) =>
    request<{channel: Channel}>(`/circles/${circleId}/channels`, {method: 'POST', token, body}),

  /**
   * Rename a channel / change its description. Founder-gated by the service.
   *
   * ⚠️ `description: null` **clears** it; omitting the key leaves it unchanged. The two are different
   * intents, and the panel renders an absent description as nothing rather than an empty line.
   */
  updateChannel: (
    token: string,
    circleId: string,
    channelId: string,
    body: {name?: string; description?: string | null},
  ) => request<{channel: Channel}>(`/circles/${circleId}/channels/${channelId}`, {method: 'POST', token, body}),

  createProposal: (token: string, circleId: string, body: {title: string; body: string}) =>
    request<{proposal: Proposal}>(`/circles/${circleId}/proposals`, {
      method: 'POST',
      token,
      body,
    }),

  vote: (token: string, proposalId: string, value: 'yes' | 'no') =>
    request<{proposal: Proposal}>(`/proposals/${proposalId}/vote`, {
      method: 'POST',
      token,
      body: {value},
    }),

  registerDevice: (
    token: string,
    body: {fcmToken: string; platform: string; nonce: string; signature: string; contract?: string},
  ) => request<{registered: boolean}>('/devices', {method: 'POST', token, body}),
}
