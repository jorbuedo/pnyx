/**
 * The last plan a shared wallet's gap scan produced, kept on disk.
 *
 * Every other kind of wallet survives an endpoint that will not answer: it seeds its
 * rail from the address rows discovery persisted and shows a balance while the scan
 * catches up. A CIP-1854 wallet had nothing to fall back on — its addresses come from
 * compiled scripts rather than a table — so one refused call anywhere in a ~20-call
 * walk took the whole rail down: no balance, no activity, no receive address, and the
 * state stuck until the screen was re-mounted, which started the same walk again.
 *
 * A plan is a safe thing to replay. The roster is fixed at creation, so index *n*
 * compiles to the same script and the same address forever; a stale plan can only be
 * incomplete — a newly-funded index it has not seen — never wrong about what it does
 * name. And the rail reads UTxOs live for the addresses in it, so the balance is not
 * frozen with the plan.
 *
 * No expiry, deliberately. A month-old plan is still the best answer available when
 * the scan cannot run, and pretending otherwise would only re-create the failure this
 * exists to end. The age is logged instead.
 *
 * @module
 */

import type {Address} from '@pnyx/cardano-core'
import type {StorageError} from '@pnyx/storage'
import {Effect} from 'effect'
import {logger} from '../../../logger'
import {createProfileStorage} from '../../profile/profile-storage'
import type {SharedRailPlan} from './rail-resolution'

/** Bumped when the plan shape changes; an older entry is discarded, not migrated. */
const CACHE_VERSION = 1

export const railPlanKey = (network: Address.Network, walletId: string): string =>
  `@pnyx/multisig_rail_plan:${network}:${walletId}`

export type StoredRailPlan = {
  /** When the scan that produced it finished. */
  readonly at: number
  readonly plan: SharedRailPlan
}

const isOther = (v: unknown): v is SharedRailPlan['others'][number] => {
  if (v === null || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.keyIndex === 'number' && typeof o.addressBech32 === 'string' && o.addressBech32.length > 0
}

/**
 * Parse a stored plan, or `null` for anything that is not one.
 *
 * Shape is checked rather than trusted, because the `keyIndex` is what a spend
 * derives its signing path from: a half-written record reviving into a plan with a
 * missing index would build a transaction against the wrong script.
 */
export const decodeRailPlan = (raw: string | null): StoredRailPlan | null => {
  if (raw === null || raw === '') return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    // Costs the fallback, so it is worth a line: a scan that cannot run will look
    // like a wallet that has never had one.
    logger.debug('a stored shared wallet rail plan would not parse; it will be re-scanned', {
      origin: 'SharedRail',
      error: String(e),
    })
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  const c = parsed as Record<string, unknown>
  if (c.version !== CACHE_VERSION || typeof c.at !== 'number') return null
  const p = c.plan
  if (p === null || typeof p !== 'object') return null
  const plan = p as Record<string, unknown>
  if (typeof plan.keyIndex !== 'number' || typeof plan.primaryAddress !== 'string') return null
  if (plan.primaryAddress.length === 0) return null
  if (!Array.isArray(plan.others) || !plan.others.every(isOther)) return null
  if (typeof plan.spansIndexes !== 'boolean' || typeof plan.truncated !== 'boolean') return null
  return {
    at: c.at,
    plan: {
      keyIndex: plan.keyIndex,
      primaryAddress: plan.primaryAddress,
      others: plan.others,
      spansIndexes: plan.spansIndexes,
      truncated: plan.truncated,
    },
  }
}

export const encodeRailPlan = (stored: StoredRailPlan): string =>
  JSON.stringify({version: CACHE_VERSION, at: stored.at, plan: stored.plan})

const storage = () => createProfileStorage()

export const loadRailPlan = (
  network: Address.Network,
  walletId: string,
): Effect.Effect<StoredRailPlan | null, StorageError> =>
  Effect.map(storage().get(railPlanKey(network, walletId)), decodeRailPlan)

/**
 * Keep this plan as the wallet's fallback.
 *
 * Only ever called with a plan from a walk the provider answered in full. A refused
 * walk is not an answer — persisting what it had reached would fix an under-reported
 * set of funded indexes in place long after the endpoint recovered. A plan the scan
 * *truncated* at its index ceiling is kept, because it says so itself and every
 * consumer already reads that flag.
 */
export const saveRailPlan = (
  network: Address.Network,
  walletId: string,
  plan: SharedRailPlan,
  atMs: number,
): Effect.Effect<void, StorageError> => storage().set(railPlanKey(network, walletId), encodeRailPlan({at: atMs, plan}))
