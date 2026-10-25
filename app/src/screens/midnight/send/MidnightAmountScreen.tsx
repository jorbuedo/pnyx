/**
 * The send funnel's amount step, on the Midnight rail.
 *
 * The figure is `AmountEditor`, the same one Cardano's per-token editor uses — same hero, same
 * 25/50/75/Max chips, same styling. What is Midnight's is here: which token the rail spends, where
 * its balance comes from, and that the CTA goes straight to review rather than back to a basket,
 * because there is no basket — one recipient, one token, one amount.
 *
 * ⚠️ **The token is chosen, not assumed.** This step used to spend NIGHT whatever the rail was, which
 * on the shielded rail asks for a colour that cannot exist: NIGHT has no shielded form, so the
 * selector answered "holds 0 of this token" and no shielded asset could be sent at all. The rail's own
 * holdings are the options, and the chosen one travels to the review as part of the asset id.
 *
 * Max is the plain balance rather than Cardano's send-all flag: the fee is DUST somebody else pays,
 * so it does not come out of this figure and there is nothing for a build to resolve later.
 *
 * The balance check lives here rather than in `SendFlowProvider` for the same reason: this is where
 * the Midnight balance is read, so this is the only place an overspend can be shown against the
 * field that caused it.
 *
 * @module
 */

import {useMemo, useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {EmptyState} from '../../../components/EmptyState'
import {RadioMark} from '../../../components/RadioMark'
import {Typography} from '../../../components/Typography'
import {useMidnightAssets} from '../../../hooks/useMidnightAssets'
import {useFormat, useI18n} from '../../../providers'
import {midnightAssetId, parseMidnightAssetId} from '../../../services/midnight/wallet/midnight-asset-id'
import {midnightTokenDecimals, midnightTokenLabel} from '../../../services/midnight/wallet/midnight-portfolio'
import {NIGHT_TOKEN_TYPE} from '../../../services/midnight/wallet/unshielded-utxo-set'
import {useSendFlow} from '../../cardano/send/SendFlowProvider'
import {AmountEditor} from '../../send/AmountEditor'

const styles = StyleSheet.create(({spacing}) => ({
  tokens: {gap: spacing.spacing8, alignSelf: 'stretch'},
  token: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing8},
}))

export const MidnightAmountScreen = () => {
  const {t} = useI18n()
  const format = useFormat()
  const {state, startReview, reviewBusy} = useSendFlow()

  // Guarded rather than assumed: this only renders under a Midnight rail, but reading the sub-rail
  // off a Cardano state would be a type lie waiting for a routing mistake.
  const rail = state.rail.chain === 'midnight' ? state.rail.rail : null

  const {assets} = useMidnightAssets()

  /** What this rail holds, in the order the portfolio lists it. Only this rail's rows are spendable here. */
  const holdings = useMemo(() => {
    if (rail === null) return []
    return assets.flatMap((asset) => {
      const ref = parseMidnightAssetId(asset.id)
      if (ref === null || ref.rail !== rail) return []
      return [{tokenType: ref.tokenType, quantity: asset.quantity}]
    })
  }, [assets, rail])

  const [picked, setPicked] = useState<string | null>(null)

  /**
   * The token this send spends.
   *
   * NIGHT when the rail holds it, otherwise the rail's first holding — and on the unshielded rail
   * NIGHT even with no holdings at all, because an unread rail reports nothing and NIGHT is the one
   * token it is always able to hold. The shielded rail gets no such default: there is no shielded
   * NIGHT, so with nothing read there is genuinely nothing to spend yet.
   */
  const tokenType = useMemo(() => {
    if (picked !== null && holdings.some((holding) => holding.tokenType === picked)) return picked
    if (holdings.some((holding) => holding.tokenType === NIGHT_TOKEN_TYPE)) return NIGHT_TOKEN_TYPE
    const first = holdings[0]
    if (first !== undefined) return first.tokenType
    return rail === 'unshielded' ? NIGHT_TOKEN_TYPE : null
  }, [holdings, picked, rail])

  /**
   * What this rail can spend of the chosen token.
   *
   * `null`, not zero, when the rail cannot report it: the shielded balance comes from the coin core,
   * which may not have synced, and a zero there would refuse a send that is actually funded.
   */
  const available = useMemo<bigint | null>(
    () => holdings.find((holding) => holding.tokenType === tokenType)?.quantity ?? null,
    [holdings, tokenType],
  )

  if (rail === null) return null
  if (tokenType === null) {
    return <EmptyState title={t('midnightSend.nothingToSendTitle')} description={t('midnightSend.nothingToSend')} />
  }

  const assetId = midnightAssetId({rail, tokenType})
  const decimals = midnightTokenDecimals(tokenType)
  const label = midnightTokenLabel(tokenType)

  return (
    <AmountEditor
      label={label}
      // A token nothing declares decimals for is stated in its atomic units rather than scaled by a
      // guess — the same rule the portfolio row follows.
      decimals={decimals ?? 0}
      available={available}
      initial={state.targets[0]?.amounts.get(assetId) ?? 0n}
      maxMode="balance"
      ctaLabel={t('midnightSend.review')}
      ctaBusy={reviewBusy}
      overspendMessage={t('midnightSend.errorInsufficient', {token: label})}
      onCommit={(quantity) => void startReview({amount: {assetId, quantity}})}
      testIDKey="midnight"
    >
      {/* Which of the two rails the recipient's address chose. Said before the CTA because the
          difference is a wait: milliseconds unshielded, ~40 s of on-device proving shielded. */}
      <Typography variant="bodyXs_regular">
        {rail === 'shielded' ? t('midnightSend.shieldedRail') : t('midnightSend.unshieldedRail')}
      </Typography>
      {holdings.length > 1 ? (
        <View style={styles.tokens}>
          {holdings.map((holding) => (
            <Pressable
              key={holding.tokenType}
              style={styles.token}
              accessibilityRole="radio"
              accessibilityState={{selected: holding.tokenType === tokenType}}
              testID={`midnight-token-${holding.tokenType.slice(0, 8)}`}
              onPress={() => setPicked(holding.tokenType)}
            >
              <RadioMark selected={holding.tokenType === tokenType} />
              <Typography variant="bodySm_regular">
                {format(holding.quantity, {
                  preset: 'cryptoBalance',
                  currency: midnightTokenLabel(holding.tokenType),
                  decimals: midnightTokenDecimals(holding.tokenType) ?? 0,
                })}
              </Typography>
            </Pressable>
          ))}
        </View>
      ) : null}
    </AmountEditor>
  )
}
