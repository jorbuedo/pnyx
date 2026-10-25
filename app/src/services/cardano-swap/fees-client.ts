/**
 * SteelSwap's partner fee dashboard (`/api/v2/fees/*`) and the partner profile.
 *
 * ⚠️ **Read §0 of `docs/CARDANO_SWAP_INTEGRATION_PLAN.md` before assuming these
 * numbers describe Pnyx.** `/swap/build` derives the fee channel from the
 * *authenticated principal*, and `POST /auth/keys` auto-provisions a
 * `self_serve` Partner for whatever wallet logged in. Today every install mints
 * its own key from its own identity, so these endpoints report **that install's**
 * account — not a Pnyx-wide one. Until the fee-bearing calls are routed through
 * a Pnyx-held partner credential, a non-zero total here means the *user* earned
 * it, which is a different fact.
 *
 * ⚠️ `?partner=<slug>` is OWNER/ADMIN only. A partner's own key already resolves
 * to its own account and the parameter is ignored for it — it can never be used
 * to read someone else's.
 *
 * @module
 */

import {Effect} from 'effect'
import {getCardanoAssetsConfig} from '../cardano-assets/config'
import {type SteelswapError, steelswapAuthedJson} from '../cardano-assets/steelswap'
import type {FetchLike} from '../cardano-assets/token-metadata'

const defaultFetch: FetchLike = (url, init) => fetch(url, init as RequestInit) as unknown as ReturnType<FetchLike>
const config = () => getCardanoAssetsConfig('mainnet')

const str = (v: unknown): string | null => (typeof v === 'string' && v.length > 0 ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
/** Lovelace amounts come back as decimal strings; keep them exact. */
const lovelace = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '0')

export type FeeSummary = {
  readonly source: string
  readonly txCount: number
  readonly feeValue: string
}

export type FeeAccount = {
  readonly feeAddress: string | null
  readonly balance: string
  /** Payable now — the orders behind it resolved. */
  readonly claimable: string
  /** Still tied to resting orders. */
  readonly held: string
  readonly threshold: string
  readonly shouldDistribute: boolean
}

export type PayoutEntry = {readonly txHash: string; readonly time: number; readonly amount: string}

export type FeePayouts = {
  readonly rewardAddress: string | null
  /** Lifetime lovelace ever paid out, stable while paging. */
  readonly totalPaid: string
  readonly total: number | null
  readonly payouts: readonly PayoutEntry[]
}

export type PartnerProfile = {
  readonly partnerId: string | null
  readonly name: string | null
  /** `self_serve` (auto-provisioned by a key mint) or `integration` (a real partner deal). */
  readonly kind: string
  readonly feeBps: number | null
  readonly feeSplitBps: number | null
  readonly feeFlatAmount: number | null
  readonly fixedPlatformFeeLovelace: number | null
  readonly freeOnSingleRoute: boolean
  readonly rewardAddress: string | null
  readonly feeAddress: string | null
  /** Today's request count against the plan's daily quota. */
  readonly requestsToday: number
  readonly dailyQuota: number | null
  readonly withinQuota: boolean
}

export const fetchFeeSummary = (
  nowMs: number,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<FeeSummary, SteelswapError> =>
  steelswapAuthedJson(config(), '/api/v2/fees/summary', {}, nowMs, fetchImpl).pipe(
    Effect.map((body) => {
      const b = (body ?? {}) as Record<string, unknown>
      return {source: str(b.source) ?? '', txCount: num(b.txCount) ?? 0, feeValue: lovelace(b.feeValue)}
    }),
  )

/**
 * ⚠️ `refresh` forces a full re-scan of the fee address, which the API documents
 * as slow. The default serves a snapshot up to 45 s old — never poll with
 * `refresh: true`.
 */
export const fetchFeeAccount = (
  nowMs: number,
  opts: {readonly refresh?: boolean} = {},
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<FeeAccount, SteelswapError> =>
  steelswapAuthedJson(
    config(),
    `/api/v2/fees/account${opts.refresh === true ? '?refresh=true' : ''}`,
    {},
    nowMs,
    fetchImpl,
  ).pipe(
    Effect.map((body) => {
      const b = (body ?? {}) as Record<string, unknown>
      return {
        feeAddress: str(b.feeAddress),
        balance: lovelace(b.balance),
        claimable: lovelace(b.claimable),
        held: lovelace(b.held),
        threshold: lovelace(b.threshold),
        shouldDistribute: b.shouldDistribute === true,
      }
    }),
  )

export const fetchFeePayouts = (
  nowMs: number,
  opts: {readonly limit?: number; readonly offset?: number} = {},
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<FeePayouts, SteelswapError> => {
  const p: string[] = []
  if (opts.limit !== undefined) p.push(`limit=${opts.limit}`)
  if (opts.offset !== undefined) p.push(`offset=${opts.offset}`)
  return steelswapAuthedJson(
    config(),
    `/api/v2/fees/payouts${p.length > 0 ? `?${p.join('&')}` : ''}`,
    {},
    nowMs,
    fetchImpl,
  ).pipe(
    Effect.map((body) => {
      const b = (body ?? {}) as Record<string, unknown>
      const rows = Array.isArray(b.payouts) ? b.payouts : []
      return {
        rewardAddress: str(b.rewardAddress),
        totalPaid: lovelace(b.totalPaid),
        total: num(b.total),
        payouts: rows.map((r) => {
          const o = (r ?? {}) as Record<string, unknown>
          return {txHash: str(o.txHash) ?? '', time: num(o.time) ?? 0, amount: lovelace(o.amount)}
        }),
      }
    }),
  )
}

export const fetchPartnerProfile = (
  nowMs: number,
  fetchImpl: FetchLike = defaultFetch,
): Effect.Effect<PartnerProfile, SteelswapError> =>
  steelswapAuthedJson(config(), '/api/v2/auth/partner', {}, nowMs, fetchImpl).pipe(
    Effect.map((body) => {
      const b = (body ?? {}) as Record<string, unknown>
      const usage = (b.usage ?? {}) as Record<string, unknown>
      return {
        partnerId: str(b.partner_id),
        name: str(b.name),
        kind: str(b.kind) ?? 'unknown',
        feeBps: num(b.fee_bps),
        feeSplitBps: num(b.fee_split_bps),
        feeFlatAmount: num(b.fee_flat_amount),
        fixedPlatformFeeLovelace: num(b.fixed_platform_fee_lovelace),
        freeOnSingleRoute: b.free_on_single_route === true,
        rewardAddress: str(b.reward_address),
        feeAddress: str(b.fee_address),
        requestsToday: num(usage.requests_today) ?? 0,
        dailyQuota: num(usage.daily_quota),
        withinQuota: usage.within_quota !== false,
      }
    }),
  )
