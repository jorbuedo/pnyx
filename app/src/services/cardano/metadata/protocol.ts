/**
 * Naming a transaction after the protocol its metadata belongs to.
 *
 * A registered label says which protocol *claims* the payload — Reeve's financial
 * records, a Catalyst registration, a dApp registration. That is worth surfacing:
 * "Send" tells a reader nothing about a transaction whose entire point was to
 * publish a journal.
 *
 * **What this may not do is assert the payload is genuine.** Metadata is
 * unauthenticated: anyone can attach label 1447 to any transaction, and nothing on
 * chain checks it. So the attribution is only ever allowed to *name* the protocol,
 * never to vouch for it, and it never replaces a title that describes where money
 * went:
 *
 * - A transaction that moves value to somebody else is a transfer that also carries
 *   a record. It keeps its own title and shows the protocol beside it — burying "you
 *   sent 500 ADA" under a protocol name would hide the part that costs money.
 * - A transaction that moves nothing outward is *only* the carrier, so the protocol
 *   is the honest title. Same rule `isPureRewardWithdrawal` uses for "Rewards".
 *
 * Pure — no React, no i18n. The name is untranslated data from the label registry.
 *
 * @module
 */

import type {ReviewedTransaction} from '@pnyx/tx-review'
import {metadataLabelInfo} from './label-registry'

/** CIP-20 is rendered as the sender's message, not as a protocol. */
const CIP20_LABEL = '674'

export type MetadataProtocol = {
  /** The label this came from, as it appears on chain. */
  readonly label: string
  /** Registry name for the protocol. Never translated. */
  readonly name: string
  /**
   * True when the transaction moved nothing to anyone else, so carrying the payload
   * was its whole purpose and the protocol can title it outright.
   */
  readonly isCarrierOnly: boolean
}

/**
 * The registered protocol a transaction's metadata belongs to, or `null`.
 *
 * Labels are considered in ascending numeric order so a transaction carrying several
 * is named deterministically rather than by object key order. Unregistered labels are
 * skipped: ~98.5% of the label space in use is unregistered, and inventing a name for
 * one would be exactly the guess the registry refuses to make.
 */
export const metadataProtocol = (reviewed: ReviewedTransaction): MetadataProtocol | null => {
  const labels = Object.keys(reviewed.metadata)
    .filter((key) => /^\d+$/.test(key) && key !== CIP20_LABEL)
    .sort((a, b) => Number(a) - Number(b))

  for (const label of labels) {
    const info = metadataLabelInfo(label)
    if (info !== undefined) return {label, name: info.name, isCarrierOnly: isCarrierOnly(reviewed)}
  }
  return null
}

/**
 * Compose a title with the protocol its metadata names.
 *
 * A carrier-only transaction takes the protocol as its title; one that also moved
 * value keeps its own and wears the protocol beside it. `base` stays first in that
 * case so the reader still reads "Send" before anything else.
 */
export const protocolTitle = (base: string, protocol: MetadataProtocol | null): string =>
  protocol === null ? base : protocol.isCarrierOnly ? protocol.name : `${base} · ${protocol.name}`

/**
 * True when no value reached any party other than this wallet — including our own
 * identity and escrows, which are still somebody the money went to.
 *
 * The fee alone does not count as movement: publishing a record costs a fee by
 * construction, and a transaction that only paid one is still purely a carrier.
 */
const isCarrierOnly = (reviewed: ReviewedTransaction): boolean =>
  ![reviewed.identityGroup, reviewed.escrowGroup, reviewed.otherGroup].some((group) =>
    group.parties.some((party) => party.received.length > 0),
  )
