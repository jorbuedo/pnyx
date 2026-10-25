/**
 * Which identities we vouch for, and which one answers support.
 *
 * **Keyed on `C`, never on a name.** Names are not policed — every script is allowed and confusables
 * are deliberately not rejected — so "is this name impersonating support?" is a question with no
 * bounded answer. "Is this `pnyx_id` ours?" has exactly one, and it cannot be forged: the mark
 * attaches to a commitment nobody else can hold.
 *
 * ⚠️ **Every configured id is decoded before it is trusted.** A remote-config string is just a
 * string; one that is not a readable `pnyx_id` is dropped with a log rather than carried into a
 * comparison that would silently never match. This is the same rule the stored identity learned the
 * hard way: validate a value against the format that will read it, not against its type.
 *
 * ⚠️ **Comparison is on the re-encoded form.** `pnyx_id`s are bech32m and case-insensitive in
 * principle, so comparing the raw configured strings would let an equivalent spelling miss. Both
 * sides are decoded and re-encoded, which is what `peer-input` already does for typed ids.
 *
 * @module
 */

import type {RemoteOfficialConfig} from '@pnyx/config'
import {decodePnyxId, encodePnyxId} from '@pnyx/contract-client/identity'
import {logger} from '../logger'

const ORIGIN = 'official-identity'

/** The decoded, canonical form of what remote config declared. */
export type OfficialIdentities = {
  /** Canonical `pnyx_id`s that render with the mark. */
  readonly marked: ReadonlySet<string>
  /** Who "Ask support" opens a conversation with, when one is configured and readable. */
  readonly support: string | undefined
}

export const NO_OFFICIAL_IDENTITIES: OfficialIdentities = {marked: new Set(), support: undefined}

/** Re-encode an id from its decoded bytes, or `undefined` when it is not one. */
const canonical = (pnyxId: string, what: string): string | undefined => {
  try {
    return encodePnyxId(decodePnyxId(pnyxId).identity)
  } catch (error) {
    logger.warn('an official identity is not a readable pnyx_id; ignoring it', {
      origin: ORIGIN,
      what,
      error: String(error),
    })
    return undefined
  }
}

/**
 * Read the configured set.
 *
 * ⚠️ **`support` is required to be in `identities`.** An id that answers support but renders without
 * the mark is the worst of both: the one conversation a user is told to trust looks like any other.
 * Rather than silently adding it, this reports the inconsistency and still marks it — the alternative
 * is a support conversation with no mark, which is the failure the mark exists to prevent.
 */
export const readOfficialIdentities = (config: RemoteOfficialConfig | undefined): OfficialIdentities => {
  if (config === undefined) return NO_OFFICIAL_IDENTITIES
  const marked = new Set<string>()
  for (const declared of config.identities ?? []) {
    const id = canonical(declared, 'identities')
    if (id !== undefined) marked.add(id)
  }
  const support = config.support === undefined ? undefined : canonical(config.support, 'support')
  if (support !== undefined && !marked.has(support)) {
    logger.warn('the support identity was not listed as official; marking it anyway', {origin: ORIGIN})
    marked.add(support)
  }
  logger.debug('official identities read', {origin: ORIGIN, marked: marked.size, hasSupport: support !== undefined})
  return {marked, support}
}

/** Whether `pnyxId` is one of ours. Accepts any spelling a decode can read. */
export const isOfficialIdentity = (pnyxId: string, official: OfficialIdentities): boolean => {
  if (official.marked.size === 0) return false
  const id = canonical(pnyxId, 'subject')
  return id !== undefined && official.marked.has(id)
}
