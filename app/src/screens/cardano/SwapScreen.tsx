/**
 * Cardano swap — quote-first UI over SteelSwap V2. Pick a "from" token (from the
 * wallet's held assets — you can only sell what you hold) and a "to" token (from
 * the full tradeable universe — you can buy anything), enter an amount, and see a
 * live debounced quote (output, route DEX, price impact, fees).
 *
 * The CTA hands off to the swap review screen, which complements — not replaces —
 * the shared review → biometric signing ceremony that Send and dApp flows use.
 *
 * @module
 */

import {useRouter} from 'expo-router'
import {useEffect, useMemo, useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {AssetAmountRow} from '../../components/AssetAmountRow'
import {Button} from '../../components/Buttons/Button'
import {Card} from '../../components/Card'
import {ChamferBackground} from '../../components/Chamfer'
import {EmptyState} from '../../components/EmptyState'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SegmentedControl} from '../../components/SegmentedControl'
import {SensitiveTypography} from '../../components/SensitiveTypography'
import {StickyFooter} from '../../components/StickyFooter'
import {TokenIcon} from '../../components/TokenIcon'
import {Typography} from '../../components/Typography'
import {UniIcon} from '../../components/UniIcon'
import {atcRatePerOfferUnit, useAtcReferenceQuote} from '../../hooks/useAtcReferenceQuote'
import {useBatcherHealth} from '../../hooks/useBatcherHealth'
import {useCardanoPortfolio} from '../../hooks/useCardanoPortfolio'
import {useDexNames} from '../../hooks/useDexNames'
import {useFeatureFlag} from '../../hooks/useFeatureFlag'
import {useLimitOrder} from '../../hooks/useLimitOrder'
import {useNetworkCapabilities} from '../../hooks/useNetworkCapabilities'
import {useProgrammableAssetIds} from '../../hooks/useProgrammableHoldings'
import {useSteelswapCredential} from '../../hooks/useSteelswapCredential'
import {useSwapExecution} from '../../hooks/useSwapExecution'
import {useSwapQuote} from '../../hooks/useSwapQuote'
import {useToast} from '../../hooks/useToast'
import {logger} from '../../logger'
import {useFormat, useI18n, useNumberParser} from '../../providers'
import {NIGHT_ASSET_ID} from '../../services/cardano/night-redeem'
import {useAssetFiat} from '../../services/cardano-assets/hooks'
import type {SwapEstimate} from '../../services/cardano-swap/client'
import {assetIdToSwapUnit} from '../../services/cardano-swap/swap-asset'
import type {TradeableToken} from '../../services/cardano-swap/token-universe'
import {SwapTokenPickerSheet} from './SwapTokenPickerSheet'
import {AssetPickerSheet} from './send/AssetPickerSheet'
import {registerSwapIntent} from './swap-intent'

/** One side of the pair, carrying the decimals + label needed for display. */
type Side = {readonly id: string; readonly decimals: number; readonly label: string}
const ADA_SIDE: Side = {id: '', decimals: 6, label: 'ADA'}
const PCTS = [25, 50, 75] as const
/** Default max slippage until a per-swap slippage control ships. */
const DEFAULT_SLIPPAGE_BPS = 50
const isAdaId = (id: string): boolean => id === '' || id === '.'

/** Exact bigint→plain-decimal string (no grouping) for feeding the amount input. */
const canonicalToDecimal = (value: bigint, decimals: number): string => {
  if (decimals === 0) return value.toString()
  const s = value.toString().padStart(decimals + 1, '0')
  const int = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return frac.length > 0 ? `${int}.${frac}` : int
}

type PickerTarget = 'from' | 'to' | null

export const SwapScreen = () => {
  const {swapEnabled} = useNetworkCapabilities()
  const swapFlagEnabled = useFeatureFlag('swap')
  // A deep link, a dev probe or a back-stack entry can land here after a network switch, so the
  // screen refuses on its own rather than trusting its entry points. The flag is checked here too:
  // hiding the Wallets action is not a gate while the route is still reachable by other means.
  if (!swapEnabled || !swapFlagEnabled) return <SwapUnavailable />
  return <SwapScreenContent />
}

const SwapUnavailable = () => {
  const {t} = useI18n()
  const router = useRouter()
  return (
    <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.unavailable}>
      <EmptyState
        icon="swap"
        title={t('settings.network.swapUnavailableTitle')}
        description={t('settings.network.swapUnavailable')}
        action={{label: t('settings.network.changeNetworkAction'), onPress: () => router.push('/settings/network')}}
        testID="swap-unavailable"
      />
    </SafeAreaViewWrapper>
  )
}

const SwapScreenContent = () => {
  // A DEX cannot spend a smart-wallet UTxO, so these are listed and refused rather than offered.
  const programmableAssetIds = useProgrammableAssetIds()
  const {t} = useI18n()
  const format = useFormat()
  const router = useRouter()
  const parse = useNumberParser()
  const {assets} = useCardanoPortfolio()
  /**
   * A build rejected with `409 quote_changed` hands back the FRESH quote. The
   * screen shows what moved and asks again — it never rebuilds silently at the
   * new price.
   */
  const [movedQuote, setMovedQuote] = useState<SwapEstimate | null>(null)
  const {prepare, busy} = useSwapExecution(setMovedQuote)
  const {showToast} = useToast()
  const [now] = useState(() => Date.now())
  const fiatOf = useAssetFiat([], now)

  const [from, setFrom] = useState<Side>(ADA_SIDE)
  const [to, setTo] = useState<Side | null>(null)
  /** Cleared once the user picks a side themselves, so the default never fights them. */
  const [toTouched, setToTouched] = useState(false)
  const [amountText, setAmountText] = useState('')
  const [picker, setPicker] = useState<PickerTarget>(null)
  /** Which side the user typed into — the other one is what the quote predicts. */
  const [fixed, setFixed] = useState<'in' | 'out'>('in')
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS)
  /**
   * MAX means "everything leaves the wallet". Without `allInclusive` the fees
   * come off ON TOP of the amount, so a 100% swap could never be built.
   */
  const [allInclusive, setAllInclusive] = useState(false)
  /** Market (AMM aggregator) or Limit (the separate, keyless ATC order book). */
  const [mode, setMode] = useState<'market' | 'limit'>('market')
  /** Limit price as ask-per-offer, typed by the user. */
  const [limitPriceText, setLimitPriceText] = useState('')
  /** Once the user edits the price, the market seed stops writing over it. */
  const [limitPriceTouched, setLimitPriceTouched] = useState(false)
  const dexName = useDexNames()
  const batcher = useBatcherHealth()
  const credential = useSteelswapCredential()

  const {place: placeLimit, busy: limitBusy, unavailable: limitUnavailable} = useLimitOrder()

  /**
   * The screen opens on ADA → NIGHT: NIGHT is the network's own token, so it is
   * the trade this wallet exists to make, and an empty "To" side asks every user
   * a question with an obvious default.
   *
   * Its decimals come from the resolved token info, never a constant — SteelSwap
   * sends `0` as its unknown-decimals fallback and a wrong scale would misquote
   * by orders of magnitude. Until they resolve, nothing is preselected.
   */
  useEffect(() => {
    if (toTouched || to !== null) return
    const night = assets.find((a) => a.id === NIGHT_ASSET_ID)
    if (night === undefined || night.decimals === null) return
    setTo({id: NIGHT_ASSET_ID, decimals: night.decimals, label: night.label})
  }, [assets, to, toTouched])

  const activeDecimals = fixed === 'in' ? from.decimals : (to?.decimals ?? from.decimals)
  const parsed = useMemo(() => parse(amountText, {decimals: activeDecimals}), [parse, amountText, activeDecimals])
  const quote = useSwapQuote({
    inputAssetId: from.id,
    outputAssetId: to?.id ?? '',
    amountBaseUnits: parsed.canonical,
    fixed,
    // `allInclusive` only means anything for a fixed ADA input.
    ...(allInclusive && fixed === 'in' && isAdaId(from.id) ? {allInclusive: true} : {}),
  })

  /**
   * The market rate a limit price is judged against. Probed at ONE whole unit of
   * the offered token when nothing is typed yet, so the field can be seeded
   * before the user commits to a size.
   */
  const limitProbeAmount = useMemo(
    () => (parsed.canonical > 0n ? parsed.canonical.toString() : (10n ** BigInt(from.decimals)).toString()),
    [parsed.canonical, from.decimals],
  )
  const reference = useAtcReferenceQuote({
    offerUnit: assetIdToSwapUnit(from.id),
    askUnit: to === null ? null : assetIdToSwapUnit(to.id),
    offerAmount: limitProbeAmount,
    enabled: mode === 'limit' && to !== null,
  })
  const marketRate = useMemo(
    () =>
      reference.quote === null || to === null ? null : atcRatePerOfferUnit(reference.quote, from.decimals, to.decimals),
    [reference.quote, from.decimals, to],
  )

  /**
   * Seed the limit price from the market ONCE. Re-seeding on every re-quote
   * would overwrite what the user typed while they were typing it.
   */
  useEffect(() => {
    if (mode !== 'limit' || limitPriceTouched || marketRate === null || to === null) return
    setLimitPriceText(canonicalToDecimal(BigInt(Math.round(marketRate * 10 ** to.decimals)), to.decimals))
  }, [mode, limitPriceTouched, marketRate, to])

  // "from" is picked from held assets (already incl. ADA); "to" from the universe.
  const heldIds = useMemo(() => [...new Set(assets.map((a) => a.id))], [assets])
  const fromBalance = useMemo(() => {
    const a = assets.find((x) => x.id === from.id) ?? (isAdaId(from.id) ? assets.find((x) => x.isAda) : undefined)
    return a?.quantity ?? null
  }, [assets, from.id])

  const fromFiat = parsed.isEmpty ? null : fiatOf(isAdaId(from.id) ? '' : from.id, parsed.canonical, from.decimals)

  const outText = useMemo(() => {
    if (quote.estimate === null || to === null) return null
    try {
      return format(BigInt(quote.estimate.output.amount), {
        preset: 'cryptoBalance',
        currency: to.label,
        decimals: to.decimals,
      })
    } catch (e: unknown) {
      // `null` hides the estimate row, which is also what "no quote yet" looks like.
      logger.warn('Swap estimate could not be formatted', {origin: 'SwapScreen', error: String(e)})
      return null
    }
  }, [quote.estimate, to, format])

  const switchTokens = () => {
    if (to === null) return
    setFrom(to)
    setTo(from)
    setAmountText('')
  }

  const pickFrom = (id: string) => {
    const held = assets.find((a) => a.id === id)
    // Swapping scales the typed amount by 10^decimals, so an unknown scale would
    // send the wrong quantity. Such an asset is not selectable as a source.
    if (held !== undefined && held.decimals === null) {
      setPicker(null)
      return
    }
    setFrom(held === undefined || held.decimals === null ? ADA_SIDE : {id, decimals: held.decimals, label: held.label})
    setPicker(null)
  }
  const pickTo = (tk: TradeableToken) => {
    setToTouched(true)
    // SteelSwap sends `0` as its unknown-decimals fallback, so a token whose
    // decimals it does not know cannot be rendered at all — quoting into it
    // would print base units as if they were whole tokens.
    if (tk.decimals === null) {
      showToast({variant: 'error', message: t('swap.unknownDecimals', {token: tk.ticker || tk.name || tk.assetId})})
      return
    }
    setTo({id: tk.assetId, decimals: tk.decimals, label: tk.ticker || tk.name || tk.assetId})
    setPicker(null)
  }
  const setPct = (pct: number) => {
    if (fromBalance === null) return
    setFixed('in')
    // Only a full ADA sweep needs the fees netted out of the amount; a partial
    // one leaves enough behind to pay them the ordinary way.
    setAllInclusive(pct === 100 && isAdaId(from.id))
    setAmountText(canonicalToDecimal((fromBalance * BigInt(pct)) / 100n, from.decimals))
  }

  // The API documents `priceImpact` as always omitted — one figure has no clean
  // meaning across a split route — so there is deliberately nothing to show.
  const venues = quote.estimate?.split ?? []
  const canReview = quote.estimate !== null && to !== null && !quote.loading && !parsed.isEmpty && !busy

  const limitAsk = useMemo(() => {
    if (to === null || limitPriceText.trim() === '') return null
    const price = parse(limitPriceText, {decimals: to.decimals})
    if (price.canonical <= 0n || parsed.canonical <= 0n) return null
    // ask = offer × price, both already in base units of their own token.
    return (parsed.canonical * price.canonical) / 10n ** BigInt(from.decimals)
  }, [limitPriceText, to, parse, parsed.canonical, from.decimals])

  const canPlaceLimit = to !== null && limitAsk !== null && limitAsk > 0n && !limitBusy && !limitUnavailable

  const onPlaceLimit = async () => {
    if (to === null || limitAsk === null) return
    const offerUnit = assetIdToSwapUnit(from.id)
    const askUnit = assetIdToSwapUnit(to.id)
    if (offerUnit === null || askUnit === null) return
    const ticketId = await placeLimit({
      offerAssetId: from.id,
      offerUnit,
      offerAmount: parsed.canonical,
      askUnit,
      askAmount: limitAsk,
    })
    if (ticketId === null) return
    router.push(`/wallet/review-tx?ticket=${ticketId}` as never)
  }

  // Build the tx HERE, while inputs are still editable — a failed build (no
  // route, insufficient funds, DEX down) surfaces before committing to review.
  const onReview = async () => {
    if (quote.estimate === null || to === null) return
    const ticketId = await prepare({
      fromId: from.id,
      toId: to.id,
      amountBaseUnits: parsed.canonical,
      fixed,
      expectedOutput: quote.estimate.output,
      ...(fixed === 'out' ? {expectedInput: quote.estimate.input} : {}),
      slippageBps,
      ...(allInclusive && fixed === 'in' && isAdaId(from.id) ? {allInclusive: true} : {}),
    })
    if (ticketId === null) return
    const id = registerSwapIntent({
      from,
      to,
      amountBaseUnits: parsed.canonical,
      estimate: quote.estimate,
      slippageBps,
      ticketId,
    })
    router.push(`/wallet/swap-review?intent=${id}` as never)
  }

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.content}
      stickyFooter={
        <StickyFooter>
          <Button
            label={t(mode === 'limit' ? 'swap.limit.placeCta' : 'swap.reviewCta')}
            onPress={mode === 'limit' ? onPlaceLimit : onReview}
            fullWidth
            size="xl"
            isDisabled={mode === 'limit' ? !canPlaceLimit : !canReview}
            isLoading={quote.loading || busy || limitBusy}
            testID="swap-review"
          />
        </StickyFooter>
      }
    >
      {/* Pricing and routing need a credential. Without one every field below
          simply reads empty, which looks like "this pair has no price" rather
          than "this device cannot ask". */}
      {(credential.tag === 'failed' || credential.tag === 'noSigner' || credential.tag === 'partnerRejected') && (
        <Card style={styles.details} testID="swap-credential-warning">
          <Typography variant="bodySm_regular" style={styles.detailLabel}>
            {/* `partnerRejected` reads as the generic failure on purpose: to the person holding the
                phone both mean "this device cannot ask for a price", and the difference between a
                dead mint and a revoked partner key is an operator's fact, carried in the log. */}
            {t(credential.tag === 'noSigner' ? 'swap.noCredentialMsg' : 'swap.credentialFailedMsg')}
          </Typography>
        </Card>
      )}

      {/* A batcher that is behind means an order that sits. Warning before the
          swap beats explaining after it. */}
      {batcher.worst !== null && batcher.degraded[0] !== undefined && (
        <Card style={styles.details} testID="swap-batcher-warning">
          <Typography variant="bodySm_medium">
            {t(batcher.worst === 'DOWN' ? 'swap.batcherDownTitle' : 'swap.batcherWarnTitle')}
          </Typography>
          <Typography variant="bodySm_regular" style={styles.detailLabel}>
            {t('swap.batcherBody', {
              venue: dexName(batcher.degraded[0].protocol),
              count: batcher.degraded[0].oldestDemandAgeBlocks ?? 0,
            })}
          </Typography>
        </Card>
      )}

      {/* Market and Limit are two different order books, not two views of one —
          so the choice is a selector, and the CTA below changes with it. */}
      <SegmentedControl
        options={[
          {label: t('swap.modeMarket'), value: 'market'},
          {label: t('swap.modeLimit'), value: 'limit'},
        ]}
        value={mode}
        onChange={(m) => setMode(m as 'market' | 'limit')}
        testID="swap-mode"
      />
      <View style={styles.modeSpacer} />

      {/* From */}
      <Card style={styles.card}>
        <View style={styles.cardHead}>
          <Typography variant="bodyXs_medium" style={styles.cardLabel}>
            {t('swap.fromLabel')}
          </Typography>
          {fromBalance !== null ? (
            <Typography variant="bodyXs_regular" style={styles.balance}>
              {t('cardanoSend.available', {
                amount: format(fromBalance, {preset: 'cryptoBalance', currency: from.label, decimals: from.decimals}),
              })}
            </Typography>
          ) : null}
        </View>
        <AssetAmountRow
          assetId={from.id}
          label={from.label}
          value={parsed.inputValue}
          onChangeText={setAmountText}
          {...(fromFiat !== null
            ? {subLabel: format(fromFiat.value, {preset: 'fiatBalance', currency: fromFiat.currency})}
            : {})}
          onPressToken={() => setPicker('from')}
          testID="swap-amount"
          tokenTestID="swap-from-token"
        />
        {fromBalance !== null && fromBalance > 0n ? (
          <View style={styles.pctRow}>
            {PCTS.map((pct) => (
              <Button
                key={pct}
                label={t('cardanoSend.percent', {value: pct})}
                variant="secondary"
                size="sm"
                containerStyles={styles.pctBtn}
                onPress={() => setPct(pct)}
                testID={`swap-pct-${pct}`}
              />
            ))}
            <Button
              label={t('cardanoSend.max')}
              variant="secondary"
              size="sm"
              containerStyles={styles.pctBtn}
              onPress={() => setPct(100)}
              testID="swap-max"
            />
          </View>
        ) : null}
      </Card>

      <Pressable style={styles.switch} onPress={switchTokens} testID="swap-switch" disabled={to === null}>
        <ChamferBackground
          size="auto"
          fillToken="backgroundAlternative"
          borderToken="borderDefaultWeak"
          borderWidth={1}
        />
        <UniIcon name="swap" width={20} height={20} uniProps={(theme) => ({color: theme.colors.primaryDefault})} />
      </Pressable>

      {/* To */}
      <Card style={styles.card}>
        <Typography variant="bodyXs_medium" style={styles.cardLabel}>
          {t('swap.toLabel')}
        </Typography>
        <View style={styles.row}>
          <Pressable style={styles.tokenBtn} onPress={() => setPicker('to')} testID="swap-to-token">
            {to !== null ? <TokenIcon assetId={to.id} label={to.label} size={28} /> : null}
            <Typography variant="bodyMd_medium">{to?.label ?? t('swap.selectTokenCta')}</Typography>
            <UniIcon name="rightThin" width={12} height={12} uniProps={(theme) => ({color: theme.colors.textMuted})} />
          </Pressable>
          <SensitiveTypography variant="bodyMd_medium" style={styles.outAmount} numberOfLines={1}>
            {quote.loading ? '…' : (outText ?? '0')}
          </SensitiveTypography>
        </View>
      </Card>

      {/* Quote details. A failed quote must say so: without a message the screen
          shows an untouched "To" amount and a disabled button, which reads as
          "nothing happened" rather than "the quote service did not answer". */}
      {quote.error === 'no_route' ? (
        <Typography variant="bodySm_regular" style={styles.error}>
          {t('swap.noRouteMsg')}
        </Typography>
      ) : quote.error === 'throttled' ? (
        <Typography variant="bodySm_regular" style={styles.error}>
          {t('swap.quoteThrottledMsg')}
        </Typography>
      ) : quote.error === 'failed' ? (
        <Typography variant="bodySm_regular" style={styles.error}>
          {t('swap.quoteFailedMsg')}
        </Typography>
      ) : quote.error === 'chain_unavailable' ? (
        <Typography variant="bodySm_regular" style={styles.error}>
          {t('swap.buildUnavailableMsg')}
        </Typography>
      ) : quote.error === 'insufficient_input' ? (
        <Typography variant="bodySm_regular" style={styles.error}>
          {t('swap.insufficientInputMsg')}
        </Typography>
      ) : quote.error === 'no_credential' ? (
        <Typography variant="bodySm_regular" style={styles.error}>
          {t('swap.noCredentialMsg')}
        </Typography>
      ) : quote.error === 'failed' ? (
        <Typography variant="bodySm_regular" style={styles.error}>
          {t('swap.quoteFailedMsg')}
        </Typography>
      ) : quote.estimate !== null ? (
        <Card style={styles.details}>
          {venues.length > 0 && (
            <Detail
              label={t('swap.routeLabel')}
              value={
                venues.length === 1
                  ? (dexName(venues[0]?.dex ?? '') ?? '')
                  : t('swap.routeVenues', {count: venues.length})
              }
            />
          )}
          <Detail
            label={t('swap.batcherFeeLabel')}
            value={format(BigInt(quote.estimate.fees.batcher.amount), {
              preset: 'cryptoFee',
              currency: 'ADA',
              decimals: 6,
            })}
          />
          {/* The deposit is returned when the order settles. Shown as a fee with
              no explanation it reads as money gone. */}
          <Detail
            label={t('swap.depositLabel')}
            hint={t('swap.depositHint')}
            value={format(BigInt(quote.estimate.fees.deposit.amount), {
              preset: 'cryptoFee',
              currency: 'ADA',
              decimals: 6,
            })}
          />
          <Detail
            label={t('swap.serviceFeeLabel')}
            value={format(BigInt(quote.estimate.fees.service.amount), {
              preset: 'cryptoFee',
              currency: 'ADA',
              decimals: 6,
            })}
          />
          {quote.estimate.bonusOutput !== null && quote.estimate.bonusOutput !== '0' && to !== null && (
            <Detail
              label={t('swap.bonusLabel')}
              value={format(BigInt(quote.estimate.bonusOutput), {
                preset: 'cryptoBalance',
                currency: to.label,
                decimals: to.decimals,
              })}
            />
          )}
          {/* Paying the fee in the input token instead of ADA is a real change to
              what leaves the wallet — never silent. */}
          {quote.estimate.babel?.applied === true && quote.estimate.babel.feeUnit !== null && (
            <Typography variant="bodyXs_regular" style={styles.babel}>
              {t('swap.babelFeeNotice', {token: from.label})}
            </Typography>
          )}
        </Card>
      ) : null}

      {movedQuote !== null && to !== null && (
        <Card style={styles.details} testID="swap-quote-changed">
          <Typography variant="bodySm_medium">{t('swap.quoteChangedTitle')}</Typography>
          <Typography variant="bodySm_regular" style={styles.detailLabel}>
            {t('swap.quoteChangedBody', {
              old: format(BigInt(quote.estimate?.output.amount ?? '0'), {
                preset: 'cryptoBalance',
                currency: to.label,
                decimals: to.decimals,
              }),
              new: format(BigInt(movedQuote.output.amount), {
                preset: 'cryptoBalance',
                currency: to.label,
                decimals: to.decimals,
              }),
            })}
          </Typography>
          <Button
            label={t('swap.quoteChangedCta')}
            variant="secondary"
            size="sm"
            onPress={() => setMovedQuote(null)}
            testID="swap-quote-changed-accept"
          />
        </Card>
      )}

      {mode === 'market' ? (
        <SlippageControl value={slippageBps} onChange={setSlippageBps} />
      ) : (
        <LimitPriceCard
          to={to}
          from={from}
          value={limitPriceText}
          onChange={(v) => {
            setLimitPriceTouched(true)
            setLimitPriceText(v)
          }}
          onUseMarket={() => {
            if (marketRate === null || to === null) return
            setLimitPriceTouched(false)
            setLimitPriceText(canonicalToDecimal(BigInt(Math.round(marketRate * 10 ** to.decimals)), to.decimals))
          }}
          marketRate={marketRate}
          referenceError={reference.error}
          unavailable={limitUnavailable}
        />
      )}

      <AssetPickerSheet
        programmableAssetIds={programmableAssetIds}
        programmableReason={t('swap.programmableUnsupported')}
        visible={picker === 'from'}
        onClose={() => setPicker(null)}
        assetIds={heldIds}
        onSelect={pickFrom}
      />
      <SwapTokenPickerSheet
        visible={picker === 'to'}
        onClose={() => setPicker(null)}
        onSelect={pickTo}
        excludeId={from.id}
      />
    </SafeAreaViewWrapper>
  )
}

const Detail = ({label, value, hint, danger}: {label: string; value: string; hint?: string; danger?: boolean}) => (
  <View style={styles.detailRow}>
    <View style={styles.detailLabelCol}>
      <Typography variant="bodySm_regular" style={styles.detailLabel}>
        {label}
      </Typography>
      {hint !== undefined && (
        <Typography variant="bodyXs_regular" style={styles.detailHint}>
          {hint}
        </Typography>
      )}
    </View>
    <Typography variant="bodySm_medium" style={danger ? styles.danger : undefined}>
      {value}
    </Typography>
  </View>
)

/** Slippage presets, in basis points. */
const SLIPPAGE_PRESETS = ['10', '50', '100', '300'] as const

/**
 * Slippage is a SELECTION among mutually-exclusive values, so it is a segmented
 * control — unlike the amount's % chips, which are actions that each change the
 * amount and have no "current" state to show.
 */
const SlippageControl = ({value, onChange}: {value: number; onChange: (bps: number) => void}) => {
  const {t} = useI18n()
  return (
    <Card style={styles.details}>
      <View style={styles.detailRow}>
        <Typography variant="bodySm_regular" style={styles.detailLabel}>
          {t('swap.slippageLabel')}
        </Typography>
      </View>
      <SegmentedControl
        options={SLIPPAGE_PRESETS.map((bps) => ({
          label: t('swap.slippagePreset', {value: Number(bps) / 100}),
          value: bps,
        }))}
        value={String(value)}
        onChange={(bps) => onChange(Number(bps))}
        testID="swap-slippage"
      />
    </Card>
  )
}

/**
 * The limit price, as ask-per-offer. Shown with the ATC reference price so the
 * number has something to be judged against — an unanchored limit is a guess.
 */
const LimitPriceCard = ({
  from,
  to,
  value,
  onChange,
  onUseMarket,
  marketRate,
  referenceError,
  unavailable,
}: {
  readonly from: Side
  readonly to: Side | null
  readonly value: string
  readonly onChange: (v: string) => void
  readonly onUseMarket: () => void
  readonly marketRate: number | null
  readonly referenceError: 'unavailable' | 'stale' | null
  readonly unavailable: boolean
}) => {
  const {t} = useI18n()
  const format = useFormat()

  if (unavailable) {
    return (
      <Card style={styles.details}>
        <Typography variant="bodySm_regular" style={styles.detailLabel}>
          {t('swap.limit.needsStakeAddress')}
        </Typography>
      </Card>
    )
  }

  // How far the typed price sits from the market — the number that says whether
  // this order is likely to rest for a long time.
  const typed = Number(value)
  const offsetPct =
    marketRate === null || !Number.isFinite(typed) || typed <= 0 || marketRate <= 0
      ? null
      : (typed / marketRate - 1) * 100

  return (
    <Card style={styles.details}>
      <View style={styles.detailRow}>
        <Typography variant="bodySm_regular" style={styles.detailLabel}>
          {t('swap.limit.priceLabel')}
        </Typography>
        <Typography variant="bodyXs_regular" style={styles.detailHint}>
          {t('swap.limit.priceHint', {token: from.label})}
        </Typography>
      </View>
      <AssetAmountRow
        assetId={to?.id ?? ''}
        label={to?.label ?? t('swap.selectTokenCta')}
        value={value}
        onChangeText={onChange}
        testID="swap-limit-price"
        tokenTestID="swap-limit-token"
      />
      {/* A limit price with nothing to compare it to is a guess. */}
      {marketRate !== null && to !== null ? (
        <View style={styles.detailRow}>
          <Typography variant="bodyXs_regular" style={styles.detailHint}>
            {t('swap.limit.marketPrice', {
              price: format(BigInt(Math.round(marketRate * 10 ** to.decimals)), {
                preset: 'cryptoBalance',
                currency: to.label,
                decimals: to.decimals,
              }),
            })}
            {offsetPct === null ? '' : `  ·  ${t('swap.limit.offsetLabel', {value: offsetPct.toFixed(1)})}`}
          </Typography>
          <Pressable onPress={onUseMarket} testID="swap-limit-use-market">
            <Typography variant="bodyXs_medium" style={styles.useMarket}>
              {t('swap.limit.useMarket')}
            </Typography>
          </Pressable>
        </View>
      ) : referenceError !== null ? (
        <Typography variant="bodyXs_regular" style={styles.detailHint}>
          {t(referenceError === 'stale' ? 'swap.limit.quoteStaleIndexer' : 'swap.limit.quoteFailed')}
        </Typography>
      ) : null}
    </Card>
  )
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {padding: spacing.spacing16, gap: spacing.spacing8},
  unavailable: {flex: 1, justifyContent: 'center', padding: spacing.spacing24},
  card: {padding: spacing.spacing16, gap: spacing.spacing12},
  cardHead: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between'},
  cardLabel: {color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.9},
  balance: {color: colors.textMuted},
  row: {flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.spacing12},
  tokenBtn: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing8, flexShrink: 0},
  outAmount: {flex: 1, textAlign: 'right', color: colors.textDefault},
  pctRow: {flexDirection: 'row', gap: spacing.spacing8},
  pctBtn: {flex: 1},
  // Separates the selector from the form below it: it picks which ORDER BOOK the
  // form writes to, so it reads as a section header, not another form row.
  modeSpacer: {height: spacing.spacing12},
  // The chamfer paints the fill and the border, so this style is layout only —
  // a background/borderRadius here would draw a rounded shape underneath it.
  //
  // It sits BETWEEN the cards rather than floating over them: the negative
  // margin that pulled it into the gap made it overlap both chamfered edges,
  // and a chamfer is one painted bitmap, so an overlap reads as a clipped
  // corner rather than as layering.
  switch: {
    alignSelf: 'center',
    width: 40,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    marginVertical: spacing.spacing4,
  },
  details: {padding: spacing.spacing16, gap: spacing.spacing8, marginTop: spacing.spacing8},
  detailRow: {flexDirection: 'row', justifyContent: 'space-between'},
  detailLabelCol: {flexShrink: 1, paddingRight: spacing.spacing8},
  detailHint: {color: colors.textMuted},
  babel: {color: colors.textMuted},
  useMarket: {color: colors.primaryDefault},
  detailLabel: {color: colors.textAlternative},
  danger: {color: colors.errorDefault},
  error: {color: colors.textAlternative, textAlign: 'center', paddingVertical: spacing.spacing16},
}))
