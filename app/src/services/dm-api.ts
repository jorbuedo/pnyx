/**
 * Client for the DM delivery routes (`services/content/src/routes.ts` → `/dm/*`).
 *
 * Transport only. Every payload crossing this boundary is opaque MLS bytes, and nothing here
 * decides trust: sender authenticity comes from MLS plus the anchor in the peer's identity row
 * ({@link module:./identity-row}), never from a field the server returned. In particular the
 * `sender` on a fetched message is delivery metadata for grouping the UI — it must not be used to
 * pick a decryption key.
 *
 * Base64 is the wire encoding because the routes are JSON; conversion happens here so callers only
 * ever handle `Uint8Array`.
 *
 * @module
 */

import {serviceUrl} from './pnyx-session'

/** A DM request failed. `status` is absent when the service was unreachable. */
export class DmApiError extends Error {
  readonly status: number | undefined
  constructor(status: number | undefined, message: string, cause?: unknown) {
    super(message)
    this.status = status
    this.cause = cause
    this.name = 'DmApiError'
  }
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

const fromBase64 = (value: string): Uint8Array => {
  const binary = atob(value)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

type RequestOptions = {
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
  readonly token: string
  readonly body?: unknown
  /**
   * The permit to present, if we hold one.
   *
   * ⚠️ A header rather than a body field so it rides *every* delivery uniformly — the claim, the
   * Welcome and each message — without three payload shapes having to agree about where it lives.
   */
  readonly permit?: string | undefined
}

const request = async <T>(path: string, options: RequestOptions): Promise<T> => {
  const url = `${serviceUrl()}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.token}`,
        ...(options.permit === undefined ? {} : {'x-pnyx-dm-permit': options.permit}),
      },
      ...(options.body === undefined ? {} : {body: JSON.stringify(options.body)}),
    })
  } catch (error) {
    throw new DmApiError(undefined, `content service unreachable at ${url}`, error)
  }
  let payload: unknown
  try {
    payload = await response.json()
  } catch (error) {
    throw new DmApiError(response.ok ? undefined : response.status, `invalid JSON from ${path}`, error)
  }
  if (!response.ok) {
    throw new DmApiError(response.status, (payload as {error?: string}).error ?? `request failed: ${response.status}`)
  }
  return payload as T
}

export type DmConversationSummary = {
  readonly convId: string
  readonly peer: string
  readonly lastMessageAt: string
}

/** Which of the three policies an identity has chosen. Mirrors the service's `DmPolicy`. */
export type DmPolicyChoice = 'open' | 'permit' | 'closed'

export type DmFetchedMessage = {
  readonly id: string
  /** Delivery metadata for grouping only — MLS decides who really sent this. */
  readonly sender: string
  readonly ciphertext: Uint8Array
  readonly createdAt: string
  /**
   * The permit this delivery was made under.
   *
   * ⚠️ **This is the only way we learn the id**, and it is what muting names. The service stores no
   * mapping from a permit to the pair it covers — deliberately, so muting leaves no social graph —
   * so if this is not captured here it cannot be recovered.
   */
  readonly permitJti?: string
}

export type DmFetchedWelcome = {
  readonly id: string
  readonly convId: string
  readonly sender: string
  readonly welcome: Uint8Array
  readonly ratchetTree: Uint8Array
  readonly createdAt: string
  /** The invite's permit id; see {@link DmFetchedMessage.permitJti}. */
  readonly permitJti?: string
}

export const dmApi = {
  /** Publish public KeyPackages. Idempotent — the server keys them by content hash. */
  publishKeyPackages: async (
    token: string,
    packages: readonly Uint8Array[],
  ): Promise<{added: number; available: number}> =>
    request('/dm/key-packages', {method: 'POST', token, body: {packages: packages.map(toBase64)}}),

  /** How many of my packages remain unclaimed, so the caller knows when to refill. */
  availableKeyPackages: async (token: string): Promise<number> =>
    (await request<{available: number}>('/dm/key-packages', {token})).available,

  /**
   * Withdraw published packages whose private half this device no longer holds.
   *
   * ⚠️ **The public half outliving the private one is not a tidiness problem.** A peer can claim a
   * package we can never open, seal a Welcome to it, and watch their invite die at "no matching key
   * package" — on our side, in a log they never see. Retiring is what makes a locally pruned record
   * actually unreachable.
   *
   * Already-claimed packages are not retired and cannot be: the peer holds the bytes.
   */
  retireKeyPackages: async (token: string, ids: readonly string[]): Promise<{retired: number; available: number}> =>
    request('/dm/key-packages/retire', {method: 'POST', token, body: {ids: [...ids]}}),

  /**
   * Withdraw every unclaimed package we have published.
   *
   * ⚠️ **Only for a device that has lost its private halves wholesale** — a storage reset, a
   * reinstall, a restore — where the ids went with them and the scoped retire has nothing to name.
   * Left alone, the pool looks healthy so nothing republishes, while every peer who claims one gets
   * an invite that can never be accepted.
   */
  retireAllKeyPackages: async (token: string): Promise<{retired: number; available: number}> =>
    request('/dm/key-packages/retire', {method: 'POST', token, body: {all: true}}),

  /** Confirm Welcomes durably joined, so they stop being redelivered. */
  ackWelcomes: async (token: string, ids: readonly string[]): Promise<{acked: number}> =>
    request('/dm/welcomes/ack', {method: 'POST', token, body: {ids: [...ids]}}),

  /**
   * Confirm delivered messages, which is what lets the server drop the ciphertext.
   *
   * ⚠️ **Only after the plaintext is durably stored.** The local thread is the only copy that will
   * ever exist — a sender cannot reopen its own MLS message and a receiver's ratchet has already
   * advanced — so acking before persisting trades a re-fetch for permanent loss.
   */
  ackMessages: async (token: string, ids: readonly string[]): Promise<{acked: number}> =>
    request('/dm/messages/ack', {method: 'POST', token, body: {ids: [...ids]}}),

  /**
   * Claim a package for a peer we want to add.
   *
   * Returns `undefined` on 409, which is a real and distinct state: the peer exists but their pool
   * is empty, so they cannot be added until their client refills. Callers must surface that
   * honestly rather than reporting a generic failure — and must never reuse a previously claimed
   * package instead, since MLS init keys are single-use.
   */
  claimKeyPackage: async (token: string, peer: string, permit?: string): Promise<Uint8Array | undefined> => {
    try {
      const result = await request<{keyPackage: string}>(`/dm/key-packages/${encodeURIComponent(peer)}/claim`, {
        method: 'POST',
        token,
        permit,
      })
      return fromBase64(result.keyPackage)
    } catch (error) {
      if (error instanceof DmApiError && error.status === 409) return undefined
      throw error
    }
  },

  listConversations: async (token: string): Promise<readonly DmConversationSummary[]> =>
    (await request<{conversations: DmConversationSummary[]}>('/dm', {token})).conversations,

  /** `since` is an exclusive cursor — pass the newest `createdAt` already processed. */
  listMessages: async (token: string, convId: string, since?: string): Promise<readonly DmFetchedMessage[]> => {
    const query = since === undefined ? '' : `?since=${encodeURIComponent(since)}`
    const result = await request<{
      messages: {id: string; sender: string; ciphertext: string; createdAt: string; permitJti?: string}[]
    }>(`/dm/${convId}/messages${query}`, {token})
    return result.messages.map((m) => ({...m, ciphertext: fromBase64(m.ciphertext)}))
  },

  /**
   * Deliver one message.
   *
   * `permit` is presented when we hold one; `permit` on the *result* is one the service minted for
   * us, which happens on a first message to someone whose policy is `open`. Storing it is what makes
   * the conversation muteable — see `dm-permit-book.ts`.
   */
  sendMessage: async (
    token: string,
    convId: string,
    input: {id: string; recipient: string; ciphertext: Uint8Array; permit?: string | undefined},
  ): Promise<{id: string; createdAt: string; permit?: string}> =>
    request(`/dm/${convId}/messages`, {
      method: 'POST',
      token,
      permit: input.permit,
      body: {id: input.id, recipient: input.recipient, ciphertext: toBase64(input.ciphertext)},
    }),

  deliverWelcome: async (
    token: string,
    convId: string,
    input: {id: string; recipient: string; welcome: Uint8Array; ratchetTree: Uint8Array; permit?: string | undefined},
  ): Promise<{permit?: string}> => {
    return await request(`/dm/${convId}/welcome`, {
      method: 'POST',
      token,
      permit: input.permit,
      body: {
        id: input.id,
        recipient: input.recipient,
        welcome: toBase64(input.welcome),
        ratchetTree: toBase64(input.ratchetTree),
      },
    })
  },

  /**
   * My pending Welcomes. **Not destructive** — they are redelivered until {@link ackWelcomes}.
   *
   * ⚠️ Which means a Welcome can be seen twice, and joining twice would replace a live ratchet with
   * a fresh one and orphan everything received since. The caller must skip a conversation it already
   * has group state for, and ack it anyway.
   */
  listWelcomes: async (token: string): Promise<readonly DmFetchedWelcome[]> => {
    const result = await request<{
      welcomes: {
        id: string
        convId: string
        sender: string
        welcome: string
        ratchetTree: string
        createdAt: string
        permitJti?: string
      }[]
    }>('/dm/welcomes', {token})
    return result.welcomes.map((w) => ({
      ...w,
      welcome: fromBase64(w.welcome),
      ratchetTree: fromBase64(w.ratchetTree),
    }))
  },

  // ── Consent: who may reach me, and whether it buzzes (docs/ABUSE_MITIGATION.md §5) ──

  /** My own policy. ⚠️ There is no way to read anyone else's — that would be a target list. */
  readPolicy: async (token: string): Promise<DmPolicyChoice> =>
    (await request<{policy: DmPolicyChoice}>('/dm/policy', {token})).policy,

  writePolicy: async (token: string, policy: DmPolicyChoice): Promise<void> => {
    await request('/dm/policy', {method: 'PUT', token, body: {policy}})
  },

  /**
   * Grant the right to reach me.
   *
   * With a `bearer` the permit is **targeted**: it names that one identity and delivery checks the
   * name, so a leaked copy is worthless. Without one it is an **invitation** anyone holding it can
   * convert into a permit of their own — which is the only shape that works as a QR or a link
   * shared with a group, since the issuer cannot know in advance who will take it up.
   */
  issuePermit: async (
    token: string,
    input: {bearer?: string; notify?: boolean; ttlSeconds?: number},
  ): Promise<{permit: string; jti: string; expiresAt: number; invite: boolean}> =>
    request('/dm/permits', {method: 'POST', token, body: input}),

  /** Mute: silence a permit without un-accepting the conversation. */
  revokePermit: async (token: string, jti: string): Promise<void> => {
    await request('/dm/permits/revoke', {method: 'POST', token, body: {jti}})
  },

  unrevokePermit: async (token: string, jti: string): Promise<void> => {
    await request('/dm/permits/unrevoke', {method: 'POST', token, body: {jti}})
  },

  listBlocks: async (token: string): Promise<readonly {peer: string; createdAt: string}[]> =>
    (await request<{blocks: {peer: string; createdAt: string}[]}>('/dm/blocks', {token})).blocks,

  blockPeer: async (token: string, peer: string): Promise<void> => {
    await request('/dm/blocks', {method: 'POST', token, body: {peer}})
  },

  unblockPeer: async (token: string, peer: string): Promise<void> => {
    await request(`/dm/blocks/${encodeURIComponent(peer)}`, {method: 'DELETE', token})
  },
}
