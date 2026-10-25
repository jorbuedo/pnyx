/**
 * Resolving the rail for a CIP-1854 shared wallet: which payment index it spends
 * from, and which of its addresses the rail syncs.
 *
 * A shared wallet has an address per payment index and a *different* compiled
 * script at each, so a rail is per (wallet, index) — the account's signing path
 * and the leaves its authority names both move with it. Picking that index is
 * therefore not a detail: it decides what the wallet can spend and where change
 * and receives land.
 *
 * @module
 */

import {Provider as EvolutionProvider} from '@evolution-sdk/evolution'
import type {Address} from '@pnyx/cardano-core'
import {Effect} from 'effect'
import {logger} from '../../../logger'
import {getActiveCardanoNetwork, getCardanoRailConfig} from '../config'
import {type CardanoRail, cardanoRailLayer, getSharedWalletRail} from '../rail'
import {type DiscoveredAddress, type Discovery, discoverSharedWallet, sharedScanReader} from './discovery'
import {loadRailPlan, saveRailPlan} from './rail-plan-cache'
import {platformSharedWalletRegistry} from './storage'
import {addressNetworkOf, type SharedWallet} from './types'

export type SharedRailPlan = {
  /** The payment index the rail spends, receives and returns change at. */
  readonly keyIndex: number
  readonly primaryAddress: string
  /**
   * The wallet's other funded indexes, so the rail's balance is the whole
   * wallet's *and* a spend can draw on them: each contributes its compiled script,
   * its leaves and its signing path to the account's authority.
   */
  readonly others: readonly {readonly keyIndex: number; readonly addressBech32: string}[]
  /** True when funds sit at more than one index — see the note on {@link planSharedRail}. */
  readonly spansIndexes: boolean
  /** The scan stopped early, so the balance below it is a floor, not a total. */
  readonly truncated: boolean
}

/** The addresses the rail syncs beyond its primary. */
export const otherAddressesOf = (plan: SharedRailPlan): readonly string[] => plan.others.map((o) => o.addressBech32)

const coinOf = (address: DiscoveredAddress): bigint => address.utxos.reduce((sum, u) => sum + u.coin, 0n)

/**
 * Which index the rail should spend from, and which addresses it should sync.
 *
 * The funded index, because that is the only one a spend can draw on: a witness
 * made at one index authorises nothing at another, so an unfunded index would
 * give a wallet that shows a balance and can spend none of it. Ties go to the
 * lower index, and an empty wallet takes its first unused address — which is
 * also where its first deposit will be asked for, so the two agree by
 * construction and the wallet stays on one index rather than scattering.
 *
 * `otherAddresses` carries only the addresses actually holding coins. The rail
 * fans out one provider call per address it knows, and an address with nothing
 * on it contributes a call and no information.
 *
 * `spansIndexes` is surfaced rather than resolved here: the balance is honest
 * about the whole wallet, and the spend that would reach across is refused at
 * signing-path resolution, where it cannot be bypassed.
 */
export const planSharedRail = (discovery: Discovery): SharedRailPlan | null => {
  const first = discovery.addresses[0]
  if (first === undefined) return null
  const funded = discovery.addresses.filter((a) => a.utxos.length > 0)
  // `reduce` keeps the earlier entry on a tie, and the list is in index order —
  // so equal balances resolve to the lower index rather than to whichever came
  // back last.
  const chosen =
    funded.length > 0
      ? funded.reduce((best, a) => (coinOf(a) > coinOf(best) ? a : best))
      : (discovery.addresses.find((a) => !a.used) ?? first)
  return {
    keyIndex: chosen.scripts.index,
    primaryAddress: chosen.scripts.addressBech32,
    others: funded
      .filter((a) => a !== chosen)
      .map((a) => ({keyIndex: a.scripts.index, addressBech32: a.scripts.addressBech32})),
    spansIndexes: funded.length > 1,
    truncated: discovery.truncated,
  }
}

/**
 * The gap scan is one provider call per index — at least twenty for a wallet
 * with nothing on it — and it answers "which addresses hold coins", which needs
 * a transaction to change. So it is cached for as long as the rail's own sync
 * throttle, and every re-mount inside that window reuses the answer rather than
 * re-walking the gap.
 */
const DISCOVERY_TTL_MS = 300_000

type CachedPlan = {readonly at: number; readonly plan: SharedRailPlan}
const planCache = new Map<string, CachedPlan>()

/**
 * Scans that have started but not yet answered, by wallet id.
 *
 * ⚠️ **The plan cache alone does not stop a stampede.** It is written *after* the walk
 * finishes, so every caller arriving during a scan saw no entry and started its own —
 * and a shared wallet is resolved from several places at once (the rail hook, the
 * portfolio, history, the co-sign screen), all on the same render. One selection of a
 * two-wallet device produced 912 `address_utxos` calls over 42 addresses: the same
 * ~21-call gap walk run a dozen times per wallet, against a rate-limited indexer.
 *
 * Joining the in-flight promise makes concurrent callers share one walk. Cleared on
 * settle so a later call re-scans normally, and on failure so an error is never cached.
 */
const scanInFlight = new Map<string, Promise<SharedRailPlan>>()

export type SharedRailResolution = {
  readonly rail: CardanoRail
  readonly wallet: SharedWallet
  readonly plan: SharedRailPlan
}

export class SharedRailError extends Error {
  constructor(
    readonly reason: 'no-endpoint' | 'not-registered' | 'scan-failed' | 'no-addresses',
    message: string,
  ) {
    super(message)
    this.name = 'SharedRailError'
  }
}

/**
 * Build the rail for a shared wallet, by group id.
 *
 * The group id *is* the shared wallet's id — registration keys them together on
 * purpose, so the ordinary flows can select a shared wallet and reach its rail
 * without a second lookup table.
 */
export const resolveSharedWalletRail = async (groupId: string, nowMs: number): Promise<SharedRailResolution> => {
  const config = getCardanoRailConfig()
  if (config === null) throw new SharedRailError('no-endpoint', 'no Cardano endpoint configured')
  const network = addressNetworkOf(getActiveCardanoNetwork())
  const wallet = await Effect.runPromise(platformSharedWalletRegistry().get(network, groupId))
  if (wallet === null) {
    // The group exists but its shared wallet does not — a registry write that
    // did not land, or a wallet created on another network. Reported rather
    // than healed: guessing a roster would compile a script nobody agreed to.
    throw new SharedRailError('not-registered', `no shared wallet registered for group ${groupId}`)
  }

  const cached = planCache.get(wallet.id)
  let plan = cached !== undefined && nowMs - cached.at < DISCOVERY_TTL_MS ? cached.plan : null
  if (plan === null) {
    try {
      const joined = scanInFlight.get(wallet.id)
      if (joined !== undefined) {
        plan = await joined
      } else {
        const scan = scanFor(wallet, network, config, nowMs)
        scanInFlight.set(wallet.id, scan)
        try {
          plan = await scan
        } finally {
          scanInFlight.delete(wallet.id)
        }
      }
    } catch (scanError: unknown) {
      // The walk could not finish — retries included, so this is an endpoint that
      // stayed unavailable, not a blip. The last plan it produced is what stands
      // between that and a wallet with no rail at all. NOT written to `planCache`:
      // the next mount must try the walk again rather than settle for this.
      plan = await lastKnownPlan(network, wallet, nowMs, scanError)
    }
  }

  const handle = getSharedWalletRail(wallet, plan.keyIndex, plan.others)
  if (handle === null) throw new SharedRailError('no-endpoint', 'no Cardano endpoint configured')
  return {rail: await handle, wallet, plan}
}

/**
 * The plan a previous scan left on disk, or the scan's own failure if there is none.
 *
 * Rethrows rather than inventing anything: a wallet whose scan has never succeeded
 * has no addresses we can claim to know, and a rail built on a guessed index would
 * ask for signatures against a script nobody funded.
 */
const lastKnownPlan = async (
  network: Address.Network,
  wallet: SharedWallet,
  nowMs: number,
  scanError: unknown,
): Promise<SharedRailPlan> => {
  const stored = await Effect.runPromise(loadRailPlan(network, wallet.id)).catch((e: unknown) => {
    logger.warn('could not read the last known shared wallet rail plan', {
      origin: 'SharedRail',
      walletId: wallet.id,
      error: String(e),
    })
    return null
  })
  if (stored === null) throw scanError
  logger.warn('shared wallet gap scan failed; serving the last known plan', {
    origin: 'SharedRail',
    walletId: wallet.id,
    spendingIndex: stored.plan.keyIndex,
    planAgeMs: nowMs - stored.at,
    reason: scanError instanceof Error ? scanError.message : String(scanError),
  })
  return stored.plan
}

/** Walk the gap scan once and plan from it, caching the result. */
const scanFor = async (
  wallet: SharedWallet,
  network: Address.Network,
  config: NonNullable<ReturnType<typeof getCardanoRailConfig>>,
  nowMs: number,
): Promise<SharedRailPlan> => {
  const discovery = await Effect.runPromise(
    Effect.provide(
      Effect.gen(function* () {
        const chain = yield* EvolutionProvider.ProviderEffect
        return yield* discoverSharedWallet(
          wallet,
          sharedScanReader(chain.getUtxos, (refusal) =>
            logger.warn('Koios refused an address in a shared wallet gap scan; asking again', {
              origin: 'SharedRail',
              walletId: wallet.id,
              kind: refusal.kind,
              detail: refusal.detail,
            }),
          ),
        )
      }),
      cardanoRailLayer(config),
    ) as Effect.Effect<Discovery>,
  ).catch((e: unknown) => {
    throw new SharedRailError('scan-failed', e instanceof Error ? e.message : String(e))
  })
  const plan = planSharedRail(discovery)
  if (plan === null) throw new SharedRailError('no-addresses', 'gap scan produced no addresses')
  planCache.set(wallet.id, {at: nowMs, plan})
  // On disk too, so the next launch has a fallback rather than a dead wallet if the
  // endpoint will not answer then. A failed write costs the fallback, not the scan.
  await Effect.runPromise(saveRailPlan(network, wallet.id, plan, nowMs)).catch((e: unknown) => {
    logger.warn('could not keep the shared wallet rail plan; a refused scan will have no fallback', {
      origin: 'SharedRail',
      walletId: wallet.id,
      error: String(e),
    })
  })
  if (plan.spansIndexes) {
    // Not a failure and no longer a limitation: one transaction spends them all,
    // carrying a script and a witness set per index. Worth a line because the
    // fee is larger — a quorum's worth of signatures per index — and because a
    // co-signer will be asked for several signatures rather than one.
    logger.info('Shared wallet holds funds at several payment indexes', {
      origin: 'SharedRail',
      walletId: wallet.id,
      spendingIndex: plan.keyIndex,
      alsoFunded: plan.others.map((o) => o.keyIndex),
    })
  }
  if (plan.truncated) {
    logger.warn('Shared wallet gap scan was truncated — balance is a floor', {
      origin: 'SharedRail',
      walletId: wallet.id,
    })
  }
  return plan
}
