/**
 * Review enrichment: resolves token metadata / images / fiat for every asset in
 * the transaction ONCE, and exposes describe-helpers the tabs use to render any
 * `ReviewedAmount` (ADA + native tokens + NFTs) consistently. Provided via
 * context so the tab tree needn't prop-drill.
 *
 * Fiat is priced **at the transaction's own timestamp** when it has one, the same
 * as the activity list — applying today's rate to a two-year-old amount states a
 * value the transaction never had. Only an unsettled transaction (the signing
 * flow, no timestamp yet) is priced at the current rate, which is correct there.
 *
 * @module
 */

import type {AddressRef, ReviewedAmount, ReviewedIO, ReviewedTransaction} from '@pnyx/tx-review'
import {createContext, type ReactNode, useContext, useMemo, useState} from 'react'
import {useCardanoAddressPaths} from '../../../hooks/useCardanoAddressPaths'
import {useActivityFiat} from '../../../hooks/useCardanoPortfolioHistory'
import {useSlotDate} from '../../../hooks/useSlotDate'
import {useConfig, useFormat} from '../../../providers'
import {knownScriptKey} from '../../../services/cardano/night-redeem'
import {rewardAddressFor} from '../../../services/cardano/reward-address'
import {useAssetFiat, useTokenInfos} from '../../../services/cardano-assets/hooks'
import {
  adaTokenInfo,
  amountUnitFor,
  displayDecimals,
  type TokenInfo,
  unknownTokenInfo,
} from '../../../services/cardano-assets/token-metadata'

const ADA_IDS = new Set(['', '.'])
const isAda = (assetId?: string): boolean => assetId === undefined || ADA_IDS.has(assetId)

/** A fully described amount, presentation-ready. */
export type DescribedAmount = {
  readonly assetId: string | undefined
  readonly isAda: boolean
  readonly isNft: boolean
  /** Signed crypto text, e.g. `-1.5 ADA` / `+42 MYTOKEN`. */
  readonly cryptoText: string
  /** Signed fiat text, e.g. `-$2.31`, or null when unpriced. */
  readonly fiatText: string | null
  /** Bare (unsigned) fiat text, for rows that are not a delta. */
  readonly fiatAmountText: string | null
  /** Bare (unsigned) crypto text for chips that carry the sign elsewhere. */
  readonly amountText: string
  readonly ticker: string
}

/**
 * What the review knows about one address, for the address inspector. Every
 * field is absent rather than guessed: the producer may not have been able to
 * inspect the address's credentials, and only our own addresses have a path.
 */
export type AddressInspection = {
  readonly derivationPath?: string
  /** Payment credential hash — a key hash, or a script hash when `isScript`. */
  readonly spendingKey?: string
  readonly stakingKey?: string
  readonly rewardAddress?: string
  readonly isScript?: boolean
  /** `txReview.knownScripts.*` leaf key when the payment script is one of ours. */
  readonly knownScript?: 'glacierTreasury' | 'glacierEscrow'
}

type Enrichment = {
  readonly describe: (amount: ReviewedAmount) => DescribedAmount
  readonly inspect: (address: AddressRef) => AddressInspection
  /**
   * Wall-clock time of an absolute slot (TTL, validity start), or `null` while
   * the anchor is unresolved or the slot falls outside its era. Callers show the
   * raw slot when this is null.
   */
  readonly dateOfSlot: (slot: number | bigint) => Date | null
  readonly loading: boolean
}

const EnrichmentContext = createContext<Enrichment | null>(null)

/** Collect every asset id referenced anywhere in the tx (for batch resolution). */
const collectAssetIds = (txs: readonly ReviewedTransaction[]): string[] => {
  const out: string[] = []
  for (const reviewed of txs) out.push(...collectAssetIdsOf(reviewed))
  return out
}

const collectAssetIdsOf = (reviewed: ReviewedTransaction): string[] => {
  const ids = new Set<string>()
  const add = (amounts: readonly ReviewedAmount[]) => {
    for (const a of amounts) if (a.assetId !== undefined && !isAda(a.assetId)) ids.add(a.assetId)
  }
  for (const io of reviewed.inputs) add(io.amounts)
  for (const io of reviewed.outputs) add(io.amounts)
  add(reviewed.ownDelta)
  const groups = [reviewed.ownGroup, reviewed.identityGroup, reviewed.escrowGroup, reviewed.otherGroup]
  for (const group of groups) {
    for (const p of group.parties) {
      add(p.sent)
      add(p.received)
    }
  }
  for (const op of reviewed.operations) {
    if (op.kind === 'minting') for (const asset of op.assets) ids.add(`${op.policyIdHex}.${asset.assetNameHex}`)
  }
  return [...ids]
}

/**
 * `address.hex → credentials`, from every IO the review classified. The party
 * aggregates in the tier groups carry no credentials of their own, so this is how
 * an Overview row reaches the same facts a UTxOs row has.
 */
const collectCredentials = (txs: readonly ReviewedTransaction[]): ReadonlyMap<string, ReviewedIO['credentials']> => {
  const merged = new Map<string, ReviewedIO['credentials']>()
  for (const reviewed of txs) for (const [k, v] of collectCredentialsOf(reviewed)) if (!merged.has(k)) merged.set(k, v)
  return merged
}

const collectCredentialsOf = (reviewed: ReviewedTransaction): ReadonlyMap<string, ReviewedIO['credentials']> => {
  const byAddress = new Map<string, ReviewedIO['credentials']>()
  const add = (ios: readonly ReviewedIO[]) => {
    for (const io of ios)
      if (io.credentials !== undefined && !byAddress.has(io.address.hex)) {
        byAddress.set(io.address.hex, io.credentials)
      }
  }
  add(reviewed.inputs)
  add(reviewed.outputs)
  for (const group of [reviewed.ownGroup, reviewed.identityGroup, reviewed.escrowGroup, reviewed.otherGroup]) {
    add(group.entries)
  }
  return byAddress
}

/** Stable identity so the default does not re-trigger the memos each render. */
const EMPTY_LEGS: readonly ReviewedTransaction[] = []

export const ReviewEnrichmentProvider = ({
  reviewed,
  siblingLegs = EMPTY_LEGS,
  children,
}: {
  readonly reviewed: ReviewedTransaction
  /**
   * Other legs of the same ceremony. Widens token/price/credential lookup to
   * their assets too, so a summary spanning legs renders real tickers rather
   * than unknown-asset placeholders. Does not affect timestamp or networkId,
   * which come from `reviewed`.
   */
  readonly siblingLegs?: readonly ReviewedTransaction[]
  readonly children: ReactNode
}) => {
  const format = useFormat()
  const {network} = useConfig()
  const adaInfo = useMemo(() => adaTokenInfo(network), [network])
  const allLegs = useMemo(() => [reviewed, ...siblingLegs], [reviewed, siblingLegs])
  const ids = useMemo(() => collectAssetIds(allLegs), [allLegs])
  const {infos, loading} = useTokenInfos(ids)
  // Stable mount timestamp — the price hook keys its TTL cache off it.
  const [now] = useState(() => Date.now())
  const fiatOf = useAssetFiat(ids, now)

  // Price at the tx's own time when it has one; `useActivityFiat` returns null
  // beyond its source horizon rather than falling back to the current rate.
  const tsSec = useMemo(() => {
    if (reviewed.timestamp === undefined) return null
    const ms = Date.parse(reviewed.timestamp)
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
  }, [reviewed.timestamp])
  const txList = useMemo(() => [reviewed], [reviewed])
  const fiatAtTime = useActivityFiat(txList)

  const paths = useCardanoAddressPaths()
  const credentials = useMemo(() => collectCredentials(allLegs), [allLegs])
  const networkId = reviewed.networkId
  const dateOfSlot = useSlotDate()

  const value = useMemo<Enrichment>(() => {
    const infoFor = (assetId?: string): TokenInfo =>
      isAda(assetId) ? adaInfo : (infos.get(assetId as string) ?? unknownTokenInfo(assetId as string))

    const describe = (amount: ReviewedAmount): DescribedAmount => {
      const info = infoFor(amount.assetId)
      // The row's label still resolves ticker → name → decoded name → fingerprint; the
      // *unit* printed after the amount is separate, and is absent for a fingerprint.
      const ticker = info.ticker ?? info.label
      const unit = amountUnitFor(info)
      const negative = amount.quantity < 0n
      const magnitude = negative ? -amount.quantity : amount.quantity
      // An NFT's name is already the row's label, so repeating it in the amount
      // produced "Heroes Cats #4 / -1 Heroes Cats #4". A fingerprint fallback is the
      // same repetition for the same reason, and `amountUnitFor` returns nothing for it.
      const amountText = format(magnitude, {
        preset: 'cryptoTxDetail',
        ...(info.isNft || unit === undefined ? {} : {currency: unit}),
        decimals: displayDecimals(info.decimals),
      })
      const sign = negative ? '-' : '+'
      const assetKey = amount.assetId === undefined || isAda(amount.assetId) ? '' : amount.assetId
      // No scale ⇒ no fiat, rather than a value that is wrong by a power of ten.
      const fiat =
        info.decimals === null
          ? null
          : tsSec !== null
            ? fiatAtTime(assetKey, magnitude, info.decimals, tsSec)
            : fiatOf(assetKey, magnitude, info.decimals)
      const fiatAmountText = fiat === null ? null : format(fiat.value, {preset: 'fiatPrice', currency: fiat.currency})
      const fiatText = fiatAmountText === null ? null : `${sign}${fiatAmountText}`
      return {
        assetId: amount.assetId,
        isAda: isAda(amount.assetId),
        isNft: info.isNft,
        cryptoText: `${sign}${amountText}`,
        amountText,
        fiatText,
        fiatAmountText,
        ticker,
      }
    }
    const inspect = (address: AddressRef): AddressInspection => {
      const creds = credentials.get(address.hex)
      const payment = creds?.payment
      const stake = creds?.stake
      const path = address.bech32 !== undefined ? paths.get(address.bech32) : undefined
      const reward = stake !== undefined && networkId !== undefined ? rewardAddressFor(networkId, stake) : undefined
      const known = payment?.type === 'script' ? knownScriptKey(payment.hashHex) : undefined
      return {
        ...(path !== undefined ? {derivationPath: path} : {}),
        ...(payment !== undefined ? {spendingKey: payment.hashHex, isScript: payment.type === 'script'} : {}),
        ...(stake !== undefined ? {stakingKey: stake.hashHex} : {}),
        ...(reward !== undefined ? {rewardAddress: reward} : {}),
        ...(known !== undefined ? {knownScript: known} : {}),
      }
    }

    return {describe, inspect, dateOfSlot, loading}
  }, [infos, fiatOf, fiatAtTime, tsSec, format, loading, adaInfo, credentials, paths, networkId, dateOfSlot])

  return <EnrichmentContext.Provider value={value}>{children}</EnrichmentContext.Provider>
}

export const useEnrichment = (): Enrichment => {
  const ctx = useContext(EnrichmentContext)
  if (ctx === null) throw new Error('useEnrichment must be used within ReviewEnrichmentProvider')
  return ctx
}
