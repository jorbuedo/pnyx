/**
 * Send funnel — per-token amount editor on the Cardano rail.
 *
 * The figure itself is `AmountEditor`, shared with every other rail. What lives here is the part
 * that is Cardano's: which asset and which funding wallet the search params name, where the balance
 * and decimals come from, the ADA fiat line, and what Apply commits to — the basket, or one
 * co-funder's contribution.
 *
 * Max is offered only with a single recipient: it is a *flag* the build resolves later
 * (`maxMode: 'sendAll'`), and a build-time-resolved send-all cannot be split across several.
 *
 * @module
 */

import {useLocalSearchParams, useRouter} from 'expo-router'
import {useEffect, useState} from 'react'
import {useNetworkCapabilities} from '../../../hooks/useNetworkCapabilities'
import {useI18n, useWalletList} from '../../../providers'
import {useAssetFiat, useTokenInfos} from '../../../services/cardano-assets/hooks'
import {AmountEditor, type MaxMode} from '../../send/AmountEditor'
import {useSendFlow} from './SendFlowProvider'
import {ADA_ID, basketRemoveToken, basketSetAmount, basketToggleSendAll} from './state'

const ADA_DECIMALS = 6

export const EditAmountScreen = () => {
  const {t} = useI18n()
  const router = useRouter()
  const {adaTicker} = useNetworkCapabilities()
  const {asset, party} = useLocalSearchParams<{asset?: string; party?: string}>()
  /**
   * The funding wallet this figure belongs to, in the multi-party composer.
   *
   * Absent for an ordinary send, where the figure is the basket's. Present, and the same
   * editor writes it into that wallet's contribution instead — one amount screen, because
   * typing an amount is one thing however many wallets are paying.
   */
  const partyId = typeof party === 'string' && party !== '' ? party : null
  const assetId = asset === undefined || asset === 'ada' ? ADA_ID : decodeURIComponent(asset)

  const {state, setState, basket, setBasket, balance, balanceOfSource} = useSendFlow()
  const {selectedWalletGroup} = useWalletList()
  const selectedGroupId = selectedWalletGroup?.groupId ?? null
  const {infos} = useTokenInfos([assetId])
  const [now] = useState(() => Date.now())
  const fiatOf = useAssetFiat([], now)

  const decimals = assetId === ADA_ID ? ADA_DECIMALS : (infos.get(assetId)?.decimals ?? 0)
  const label = assetId === ADA_ID ? adaTicker : (infos.get(assetId)?.label ?? assetId.slice(0, 12))

  /**
   * The contributing wallet's own balance, when this figure belongs to one.
   *
   * `balance` from the flow is the *selected* wallet's, and for a co-funder that is
   * somebody else's money: printing it as "Available" would attribute one wallet's holdings
   * to another, and a percentage chip would take a share of the wrong wallet. Both were
   * therefore hidden for a co-funder — an honest gap, and a real one, because it left the
   * person deciding how much a wallet puts in with no idea what it holds.
   *
   * `null` means not read yet or not readable, which is why the figure is *withheld* rather
   * than defaulted: "Available: 0" would tell a funded wallet it cannot contribute.
   */
  const [partyBalance, setPartyBalance] = useState<ReadonlyMap<string, bigint> | null>(null)
  const isOwnFigure = partyId === null || partyId === selectedGroupId
  useEffect(() => {
    if (isOwnFigure || partyId === null) return
    let active = true
    void balanceOfSource(partyId).then((held) => {
      if (active) setPartyBalance(held.size > 0 ? held : null)
    })
    return () => {
      active = false
    }
  }, [isOwnFigure, partyId, balanceOfSource])

  // Known-to-be-zero and not-yet-read are different facts: a co-funder whose balance HAS been
  // read and holds none of this token has an available figure, and it is zero.
  const available = isOwnFigure
    ? (balance.get(assetId) ?? 0n)
    : partyBalance === null
      ? null
      : (partyBalance.get(assetId) ?? 0n)
  const singleRecipient = state.targets.length === 1

  /**
   * The figure this editor is opening on.
   *
   * For a party it is *that wallet's* contribution, not the basket's. Reading the basket
   * regardless prefilled every party's ADA field with the running total, because in
   * compose mode the basket holds the sum of the wallets — so opening one wallet's amount
   * showed you everybody's.
   */
  const fundingWallet = partyId === null ? null : (state.sources.find((s) => s.groupId === partyId) ?? null)
  const initial =
    fundingWallet === null
      ? (basket.amounts.get(assetId) ?? 0n)
      : assetId === ADA_ID
        ? fundingWallet.lovelace
        : (fundingWallet.assets.get(assetId) ?? 0n)

  // Send-all is a whole-wallet notion and there is no per-party version of it: the total
  // is the sum of the contributions, so "all of it" would have to mean all of *this*
  // wallet, which is not what the chip means anywhere else.
  const maxMode: MaxMode = singleRecipient && partyId === null ? 'sendAll' : 'none'

  const onCommit = (quantity: bigint, isMax: boolean) => {
    if (partyId !== null) {
      setState((prev) => ({
        ...prev,
        sources: prev.sources.map((source) => {
          if (source.groupId !== partyId) return source
          if (assetId === ADA_ID) return {...source, lovelace: quantity}
          const assets = new Map(source.assets)
          // Zero drops the token from this wallet's contribution, the same rule the
          // basket follows — a row for nothing is a row that makes the total lie.
          if (quantity === 0n) assets.delete(assetId)
          else assets.set(assetId, quantity)
          return {...source, assets}
        }),
      }))
      router.back()
      return
    }
    setBasket((b) => {
      if (isMax) return basketToggleSendAll(b, assetId, true)
      // A zero quantity drops the token from the basket (ADA row always stays).
      if (quantity === 0n && assetId !== ADA_ID) return basketRemoveToken(b, assetId)
      return basketSetAmount(b, assetId, quantity)
    })
    router.back()
  }

  return (
    <AmountEditor
      label={label}
      decimals={decimals}
      available={available}
      initial={initial}
      initialIsMax={partyId === null && basket.sendAll.has(assetId)}
      // ADA is the only asset with a price source here; a token's fiat line is not invented.
      fiat={assetId === ADA_ID ? (canonical) => fiatOf('', canonical, decimals) : undefined}
      maxMode={maxMode}
      ctaLabel={t('cardanoSend.apply')}
      onCommit={onCommit}
      // The ADA row always exists, so committing an empty figure is how it is set back to zero.
      allowEmptyCommit={assetId === ADA_ID}
      testIDKey={assetId}
    />
  )
}
