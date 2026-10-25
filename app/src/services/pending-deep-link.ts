/**
 * Deep links that arrive while the profile gate is up.
 *
 * `useDeepLinkHandler` registers its `Linking` listener inside the provider
 * tree, which the gate does not mount until a PIN has been entered. A link
 * arriving in that window would otherwise be **missed outright** — unlike a
 * cold-start URL, which `Linking.getInitialURL()` still returns later, a warm
 * `url` event has no second chance.
 *
 * So a listener runs above the gate and parks the URL here. Same shape as
 * `pending-push-intent.ts`, which exists for the same class of hazard: single
 * slot, disk-backed, TTL-bounded, consumed on read.
 *
 * Nothing here interprets the URL. The link still lands on the link-action
 * sheet and still waits for the user — the gate changes delivery, never consent.
 *
 * @module
 */

import {logger} from '../logger'
import {deviceStorage} from '../platform/storage'

/**
 * Device-global on purpose: the URL is buffered *before* a profile is chosen,
 * so it cannot live in a profile's keyspace. Links carry no wallet identity
 * (every action in `@pnyx/links` is wallet-agnostic and the user picks a wallet
 * at the sheet), so whichever profile opens can honour it.
 */
const STORAGE_KEY = '@pnyx/pending-deep-link'

/** Matches the push-intent window: long enough to survive a retry, short enough to die before a surprise. */
const TTL_MS = 5 * 60_000

type Parked = {readonly url: string; readonly createdAtMs: number}

const parse = (raw: string | null): Parked | undefined => {
  if (raw === null) return undefined
  try {
    const value = JSON.parse(raw) as Partial<Parked>
    if (typeof value.url !== 'string' || typeof value.createdAtMs !== 'number') return undefined
    return {url: value.url, createdAtMs: value.createdAtMs}
  } catch (e: unknown) {
    // `undefined` means "no link parked", so a link the user followed before onboarding is
    // dropped and they land on the default screen with no explanation.
    logger.warn('Parked deep link could not be read; it will not be resumed', {
      origin: 'pending-deep-link',
      error: String(e),
    })
    return undefined
  }
}

export const parkDeepLink = async (url: string, nowMs: number = Date.now()): Promise<void> => {
  try {
    await deviceStorage.set(STORAGE_KEY, JSON.stringify({url, createdAtMs: nowMs} satisfies Parked))
    logger.info('[PendingDeepLink] parked behind the lock', {origin: 'PendingDeepLink'})
  } catch (error) {
    logger.warn('[PendingDeepLink] park failed', {origin: 'PendingDeepLink', error: String(error)})
  }
}

/**
 * Take the parked link, if any, and clear it.
 *
 * Consume-once: a link handed over during one session must not still be sitting
 * here to fire again in a later one. An expired entry is dropped, not returned.
 */
export const consumeDeepLink = async (nowMs: number = Date.now()): Promise<string | undefined> => {
  const parked = parse(
    await deviceStorage.get(STORAGE_KEY).catch((e) => {
      logger.warn('[PendingDeepLink] read failed; a parked link is lost', {
        origin: 'PendingDeepLink',
        error: String(e),
      })
      return null
    }),
  )
  if (parked === undefined) return undefined

  await deviceStorage.remove(STORAGE_KEY).catch((e) => {
    // Consume-once depends on this removal: a link left parked fires again next session.
    logger.warn('[PendingDeepLink] failed to clear the parked link', {
      origin: 'PendingDeepLink',
      error: String(e),
    })
  })

  if (nowMs - parked.createdAtMs > TTL_MS) {
    logger.info('[PendingDeepLink] dropped, expired', {origin: 'PendingDeepLink'})
    return undefined
  }
  return parked.url
}

/** Pure decision, exported for tests: is a parked link still live at `nowMs`? */
export const isDeepLinkFresh = (createdAtMs: number, nowMs: number): boolean => nowMs - createdAtMs <= TTL_MS
