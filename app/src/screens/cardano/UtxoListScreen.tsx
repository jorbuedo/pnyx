/**
 * UTxO list — an overview of the wallet's unspent outputs, grouped by address
 * (after Yoroi's UTxO screen). Each group card shows the address with the
 * derivation path that identifies it; each UTxO row shows `txHash#index` and its
 * ADA amount + native token count, and opens the UTxO's details. No coin
 * selection — this is an overview, not coin control.
 *
 * The one action it offers is Combine: the UTxO count is what makes a send too
 * large to fit, so this is the screen where seeing the problem and fixing it
 * belong together.
 *
 * @module
 */

import type {UTxO} from '@evolution-sdk/evolution'
import {Effect} from 'effect'
import {useRouter} from 'expo-router'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {FlatList, RefreshControl, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Address} from '../../components/Address'
import {Button} from '../../components/Buttons/Button'
import {Card} from '../../components/Card'
import {EmptyState} from '../../components/EmptyState'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SensitiveTypography} from '../../components/SensitiveTypography'
import {TabsWrapper} from '../../components/Tabs'
import {Typography} from '../../components/Typography'
import {UtxoRef} from '../../components/Utxo'
import {useCardanoAddressPaths} from '../../hooks/useCardanoAddressPaths'
import {useCardanoRail} from '../../hooks/useCardanoRail'
import {useExplorerPreference} from '../../hooks/useExplorerPreference'
import {useMidnightShieldedBalance} from '../../hooks/useMidnightShieldedBalance'
import {useMidnightSync} from '../../hooks/useMidnightSync'
import {useMidnightUnshieldedAddress} from '../../hooks/useMidnightUnshieldedAddress'
import {useMidnightUnshieldedBalance} from '../../hooks/useMidnightUnshieldedBalance'
import {useNetworkCapabilities} from '../../hooks/useNetworkCapabilities'
import {useShieldedFreshness} from '../../hooks/useShieldedFreshness'
import {useToast} from '../../hooks/useToast'
import {formatGroupedInteger} from '../../i18n/number-format'
import {logger} from '../../logger'
import {useConfig, useFormat, useI18n, useNumberLocale, useWalletList} from '../../providers'
import {utxoAddressBech32, utxoAssetMap, utxoTokenCount, utxoTxHashHex} from '../../services/cardano/utxo-view'
import {amountUnitFor, type TokenInfo, unknownTokenInfo, useTokenInfos} from '../../services/cardano-assets'
import {displayDecimals} from '../../services/cardano-assets/token-metadata'
import {runMidnight} from '../../services/midnight/effect-boundary'
import {midnightExplorerTxUrl} from '../../services/midnight/explorer'
import {midnightFundsNetwork} from '../../services/midnight/networks'
import {declareShieldedBirthday} from '../../services/midnight/wallet/declare-birthday'
import {NIGHT_DISPLAY_DECIMALS} from '../../services/midnight/wallet/midnight-portfolio'
import {NIGHT_TOKEN_TYPE, type UnshieldedUtxo} from '../../services/midnight/wallet/unshielded-utxo-set'
import {ConsolidatePreview} from './utxos/ConsolidatePreview'
import {useConsolidate} from './utxos/use-consolidate'

const ADA_DECIMALS = 6

const toHex = (bytes: Uint8Array): string => {
  let out = ''
  for (const b of bytes) out += b.toString(16).padStart(2, '0')
  return out
}

type UtxoGroup = {readonly address: string; readonly utxos: readonly UTxO.UTxO[]}

/** One group in the list, tagged by chain so the renderer cannot confuse the two output shapes. */
type ListGroup =
  | {readonly kind: 'cardano'; readonly address: string; readonly utxos: readonly UTxO.UTxO[]}
  | {readonly kind: 'midnight'; readonly address: string; readonly utxos: readonly UnshieldedUtxo[]}

/** Everything one UTxO holds, for its details sheet: ADA plus each native token. */
const UtxoContents = ({utxo, infos}: {readonly utxo: UTxO.UTxO; readonly infos: ReadonlyMap<string, TokenInfo>}) => {
  const format = useFormat()
  const {adaTicker} = useNetworkCapabilities()
  return (
    <>
      <SensitiveTypography variant="bodyMd_medium">
        {format(utxo.assets.lovelace, {preset: 'cryptoBalance', currency: adaTicker, decimals: ADA_DECIMALS})}
      </SensitiveTypography>
      {[...utxoAssetMap(utxo)].map(([assetId, quantity]) => {
        const info = infos.get(assetId) ?? unknownTokenInfo(assetId)
        const unit = amountUnitFor(info)
        return (
          <SensitiveTypography key={assetId} variant="bodyMd_medium">
            {format(quantity, {
              preset: 'cryptoBalance',
              ...(unit === undefined ? {} : {currency: unit}),
              decimals: displayDecimals(info.decimals),
            })}
          </SensitiveTypography>
        )
      })}
    </>
  )
}

export const UtxoListScreen = () => {
  const {t, formatDate} = useI18n()
  const {showToast} = useToast()
  const numberLocale = useNumberLocale()
  const {network} = useConfig()
  const router = useRouter()
  const {getExplorerUrl} = useExplorerPreference()
  const format = useFormat()
  const {adaTicker} = useNetworkCapabilities()
  const {rail, unavailable} = useCardanoRail()
  const paths = useCardanoAddressPaths()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  const [utxos, setUtxos] = useState<readonly UTxO.UTxO[] | null>(null)
  const consolidate = useConsolidate(rail, selectedWalletGroup?.groupId ?? null)
  // Midnight's shielded coins are listed beside Cardano's UTxOs because the portfolio only ever shows
  // totals, so this is the one surface where held-but-unspent money is visible per item. They get their
  // own section rather than a row in an address group: a shielded coin has **no address** by design.
  // Combine stays Cardano-only — it exists because UTxO count bounds a Cardano transaction's size.
  const shielded = useMidnightShieldedBalance()
  const unshieldedAddress = useMidnightUnshieldedAddress()
  const unshielded = useMidnightUnshieldedBalance(unshieldedAddress)
  /**
   * Tabs, not one merged list (Jordi, 2026-08-20). The two chains' outputs cannot be summed or acted on
   * together: combining is Cardano-only — its UTxO count bounds transaction size, which is not Midnight's
   * constraint — and a shielded coin has no address to group under, so a single address-grouped list has
   * nowhere to put one.
   */
  const [tab, setTab] = useState<'cardano' | 'midnight'>('cardano')
  // Pull-to-refresh is the one place a shielded sync is user-initiated, which it has to be: finding a coin
  // decrypts ciphertexts, so it needs the role key and therefore a biometric prompt. A background refresh
  // would ask for a fingerprint nobody requested.
  const midnightSync = useMidnightSync()
  const freshness = useShieldedFreshness()
  const [declaring, setDeclaring] = useState(false)

  /**
   * Take the person's word for where this wallet's history starts, then scan from there.
   *
   * ⚠️ **Resets what has already been scanned**, because a commitment tree cannot be collapsed
   * backwards — starting earlier means rebuilding. Bounded while nothing calls `walletInsertCoin`:
   * every coin the state holds was found by scanning and will be found again.
   */
  const declareBirthday = useCallback(
    async (at: Date) => {
      const groupId = selectedWalletGroup?.groupId
      const fundsNetwork = midnightFundsNetwork(network)
      if (groupId === undefined || fundsNetwork === null) return
      setDeclaring(true)
      try {
        const outcome = await runMidnight(
          declareShieldedBirthday({
            groupId,
            accountIndex: selectedAccountIndex,
            network: fundsNetwork,
            atMs: at.getTime(),
          }),
        )
        if (outcome.kind === 'unreadable') {
          showToast({variant: 'error', message: t('cardanoUtxos.shieldedBirthdayFailed')})
          return
        }
        freshness.refresh()
        // Straight into the scan: the declaration on its own changes nothing a user can see, and
        // leaving them to find the sync button is leaving the job half done.
        await midnightSync.sync()
        shielded.refresh()
      } finally {
        setDeclaring(false)
      }
    },
    [selectedWalletGroup?.groupId, network, selectedAccountIndex, freshness, midnightSync, shielded, showToast, t],
  )

  useEffect(() => {
    if (rail === null) return
    let active = true
    void Effect.runPromise(rail.confirmedUtxos)
      .then((u) => {
        if (active) setUtxos(u)
      })
      .catch((e) => {
        logger.warn('Confirmed UTxO read failed; the list stays empty', {
          origin: 'UtxoListScreen',
          error: String(e),
        })
      })
    return () => {
      active = false
    }
  }, [rail])

  const groups = useMemo<UtxoGroup[]>(() => {
    if (utxos === null) return []
    const byAddress = new Map<string, UTxO.UTxO[]>()
    for (const u of utxos) {
      const existing = byAddress.get(utxoAddressBech32(u))
      if (existing) existing.push(u)
      else byAddress.set(utxoAddressBech32(u), [u])
    }
    return [...byAddress.entries()].map(([address, list]) => ({address, utxos: list}))
  }, [utxos])

  /** Midnight's unshielded outputs, grouped by address exactly as Cardano's are. */
  const midnightGroups = useMemo(() => {
    if (unshielded.utxos === null) return null
    const byAddress = new Map<string, typeof unshielded.utxos>()
    for (const u of unshielded.utxos) {
      const existing = byAddress.get(u.owner)
      if (existing) byAddress.set(u.owner, [...existing, u])
      else byAddress.set(u.owner, [u])
    }
    return [...byAddress.entries()].map(([address, list]) => ({address, utxos: list}))
  }, [unshielded.utxos])

  /**
   * The active tab's groups, tagged by chain. A discriminated union rather than a cast: `renderItem` then
   * cannot read a Cardano `value.lovelace` off a Midnight output, because the compiler will not let it.
   */
  const listData: readonly ListGroup[] =
    tab === 'cardano'
      ? groups.map((g) => ({kind: 'cardano' as const, address: g.address, utxos: g.utxos}))
      : (midnightGroups ?? []).map((g) => ({kind: 'midnight' as const, address: g.address, utxos: g.utxos}))

  // One deduped metadata fetch for every token held, so each UTxO's details can
  // name its tokens instead of counting them.
  const assetIds = useMemo(
    () => [...new Set((utxos ?? []).flatMap((u) => [...(utxoAssetMap(u)?.keys() ?? [])]))],
    [utxos],
  )
  const {infos} = useTokenInfos(assetIds)

  if (unavailable) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.center}>
        <EmptyState icon="wallet" title={t('cardanoUtxos.unavailable')} />
      </SafeAreaViewWrapper>
    )
  }

  // Two coins is the floor for a fold. A watch-only wallet is *not* excluded: it
  // builds and reviews like any other, and only signing is unavailable — the same
  // rule the send funnel follows, so the two surfaces do not disagree about what
  // a watch-only wallet may look at.
  const canConsolidate = (utxos?.length ?? 0) >= 2

  return (
    <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.content}>
      <TabsWrapper
        tabs={[
          {key: 'cardano', label: t('cardanoUtxos.tabCardano'), ...(utxos === null ? {} : {badge: utxos.length})},
          {
            key: 'midnight',
            label: t('cardanoUtxos.tabMidnight'),
            ...(unshielded.utxoCount === null ? {} : {badge: unshielded.utxoCount}),
          },
        ]}
        activeTab={tab}
        onTabChange={(key) => setTab(key === 'midnight' ? 'midnight' : 'cardano')}
        testID="utxo-tabs"
      />
      <FlatList
        data={listData}
        keyExtractor={(g) => g.address}
        refreshControl={
          <RefreshControl
            refreshing={midnightSync.syncing}
            onRefresh={() => {
              void midnightSync.sync().then(() => shielded.refresh())
            }}
          />
        }
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={
          tab === 'midnight' || utxos === null || utxos.length === 0 ? null : (
            <Card style={styles.summary}>
              <View style={styles.summaryText}>
                <Typography variant="bodyLg_medium">{t('cardanoUtxos.summaryCount', {count: utxos.length})}</Typography>
                <Typography variant="bodyXs_regular" style={styles.muted}>
                  {t('cardanoUtxos.summaryHint')}
                </Typography>
              </View>
              {canConsolidate ? (
                <Button
                  label={t('consolidate.action')}
                  variant="secondary"
                  size="sm"
                  onPress={consolidate.plan}
                  isLoading={consolidate.planning}
                  isDisabled={consolidate.planning}
                  testID="consolidate-action"
                />
              ) : null}
            </Card>
          )
        }
        ListFooterComponent={
          tab === 'cardano' ? null : (
            // Always rendered, not only when coins exist. A wallet with nothing in it is exactly the state
            // that needs a sync, and hanging the only affordance off pull-to-refresh put it out of reach
            // there: an empty list does not scroll, so the gesture never fires. Verified on device — the
            // pull produced no sync at all.
            <Card style={styles.shieldedCard}>
              <View style={styles.addressBlock}>
                <Typography variant="bodyMd_medium">{t('cardanoUtxos.shieldedTitle')}</Typography>
                <Typography variant="bodyXs_regular" style={styles.muted}>
                  {t('cardanoUtxos.shieldedHint')}
                </Typography>
              </View>
              {(shielded.coins ?? []).map((coin, i) => (
                <View
                  key={`${toHex(coin.nonce)}:${coin.mtIndex}`}
                  style={{
                    ...styles.utxoRow,
                    ...(i < (shielded.coins?.length ?? 0) - 1 ? styles.rowBorder : {}),
                  }}
                >
                  <Typography variant="bodyXs_regular" style={styles.muted}>
                    {t('cardanoUtxos.shieldedCoin', {
                      colour: toHex(coin.color).slice(0, 8),
                      index: coin.mtIndex,
                    })}
                  </Typography>
                  <SensitiveTypography variant="bodySm_medium">{String(coin.value)}</SensitiveTypography>
                </View>
              ))}
              {/* Three states, said differently on purpose: never synced is not the same as synced-and-empty,
                and neither is "some coins are committed to a transfer". */}
              <Typography variant="bodyXs_regular" style={styles.muted}>
                {shielded.coins === null
                  ? t('cardanoUtxos.shieldedNotSynced')
                  : shielded.coins.length === 0
                    ? t('cardanoUtxos.shieldedNone')
                    : t('cardanoUtxos.shieldedPending', {count: shielded.pending})}
              </Typography>
              {/* ⚠️ **"No shielded coins found" and "we have not looked here yet" render identically.**
                  Nothing syncs this rail in the background — the key that finds a coin is the key that
                  spends it — so a wallet drifts behind the moment it is left alone, and without this the
                  drift is invisible. Only shown while behind: a line saying "up to date" on every visit
                  is noise, and its absence already means it. */}
              {/* ⚠️ **A wallet made before birthdays were recorded cannot be given one by the app.** Its
                  creation height is not on the chain, and `createdAt` is only an *upper* bound — for a
                  seed imported from elsewhere it records when we first saw it, and a birthday later
                  than the truth skips the blocks between for good. So the date is proposed and the
                  person decides, with the cost of being wrong said out loud. */}
              {freshness.birthday === undefined && selectedWalletGroup !== null && (
                <>
                  <Typography variant="bodyXs_regular" style={styles.muted}>
                    {t('cardanoUtxos.shieldedNoBirthday')}
                  </Typography>
                  <Button
                    label={t('cardanoUtxos.shieldedScanFrom', {
                      date: formatDate(selectedWalletGroup.primaryWallet.createdAt),
                    })}
                    variant="secondary"
                    size="sm"
                    onPress={() => {
                      void declareBirthday(selectedWalletGroup.primaryWallet.createdAt)
                    }}
                    isDisabled={midnightSync.syncing || declaring}
                    isLoading={declaring}
                    testID="shielded-declare-birthday"
                  />
                </>
              )}
              {freshness.freshness?.kind === 'behind' && (
                <Typography variant="bodyXs_regular" style={styles.muted}>
                  {t('cardanoUtxos.shieldedBehind', {
                    blocks: formatGroupedInteger(freshness.freshness.tip - freshness.freshness.cursor, numberLocale),
                  })}
                </Typography>
              )}
              {/* ⚠️ A shielded walk is minutes, not a refresh — it starts at the wallet's birthday and
                  scans every block since. A spinner alone for that is indistinguishable from a hang, so
                  the height it has reached is on screen and the walk can be stopped. Stopping keeps
                  everything already scanned. */}
              {midnightSync.progress !== null && (
                <Typography variant="bodyXs_regular" style={styles.muted}>
                  {t('cardanoUtxos.shieldedSyncProgress', {
                    height: formatGroupedInteger(midnightSync.progress.height, numberLocale),
                    tip: formatGroupedInteger(midnightSync.progress.tip, numberLocale),
                  })}
                </Typography>
              )}
              <Button
                label={midnightSync.syncing ? t('cardanoUtxos.shieldedSyncStop') : t('cardanoUtxos.shieldedSync')}
                variant="secondary"
                size="sm"
                onPress={() => {
                  if (midnightSync.syncing) {
                    midnightSync.cancel()
                    return
                  }
                  void midnightSync.sync().then(() => shielded.refresh())
                }}
                testID="shielded-sync-action"
              />
            </Card>
          )
        }
        renderItem={({item}) => {
          if (item.kind === 'midnight') {
            const rows = item.utxos
            return (
              <Card style={styles.group}>
                <View style={styles.addressBlock}>
                  <Typography variant="bodyMd_medium">{t('cardanoUtxos.unshieldedTitle')}</Typography>
                  <Address address={item.address} />
                </View>
                {rows.map((u, i) => (
                  <UtxoRef
                    key={`${u.intentHash}:${u.outputIndex}`}
                    // The *intent* hash, not a transaction hash — one transaction carries several intents,
                    // which is why the details sheet labels it accordingly.
                    txHashHex={u.intentHash}
                    hashLabelKey="utxo.details.intent"
                    index={u.outputIndex}
                    address={item.address}
                    style={{...styles.utxoRow, ...(i < rows.length - 1 ? styles.rowBorder : {})}}
                    // The transaction that created it, when the indexer told us. No in-app detail screen
                    // for a Midnight transaction, so the explorer is the only destination.
                    explorerUrl={
                      u.createdAtTxHash === undefined
                        ? null
                        : midnightExplorerTxUrl(midnightFundsNetwork(network), u.createdAtTxHash)
                    }
                    rightAdornment={
                      <SensitiveTypography variant="bodySm_medium">
                        {u.tokenType === NIGHT_TOKEN_TYPE
                          ? format(u.value, {
                              preset: 'cryptoBalance',
                              currency: 'NIGHT',
                              decimals: NIGHT_DISPLAY_DECIMALS,
                            })
                          : `${u.value} · ${u.tokenType.slice(0, 8)}…`}
                      </SensitiveTypography>
                    }
                  />
                ))}
              </Card>
            )
          }
          const path = paths.get(item.address)
          return (
            <Card style={styles.group}>
              <View style={styles.addressBlock}>
                <Address address={item.address} {...(path !== undefined && {derivationPath: path})} />
                {path !== undefined ? (
                  <Typography variant="bodyXs_regular" style={styles.muted}>
                    {path}
                  </Typography>
                ) : null}
              </View>

              {item.utxos.map((u, i) => {
                const tokenCount = utxoTokenCount(u)
                return (
                  <UtxoRef
                    key={`${utxoTxHashHex(u)}#${Number(u.index)}`}
                    txHashHex={utxoTxHashHex(u)}
                    index={Number(u.index)}
                    address={item.address}
                    derivationPath={path}
                    explorerUrl={getExplorerUrl('tx', utxoTxHashHex(u))}
                    onViewTransaction={() => router.push(`/wallet/tx/${utxoTxHashHex(u)}` as never)}
                    style={{...styles.utxoRow, ...(i < item.utxos.length - 1 ? styles.rowBorder : {})}}
                    amounts={<UtxoContents utxo={u} infos={infos} />}
                    rightAdornment={
                      <View style={styles.amountCol}>
                        <SensitiveTypography variant="bodySm_medium">
                          {format(u.assets.lovelace, {
                            preset: 'cryptoBalance',
                            currency: adaTicker,
                            decimals: ADA_DECIMALS,
                          })}
                        </SensitiveTypography>
                        {tokenCount > 0 && (
                          <Typography variant="bodyXs_regular" style={styles.muted}>
                            {t('cardanoUtxos.tokens', {count: tokenCount})}
                          </Typography>
                        )}
                      </View>
                    }
                  />
                )
              })}
            </Card>
          )
        }}
        ListEmptyComponent={
          // Per tab, and only once that tab has actually been read: "no outputs" and "not read yet" are
          // different facts, and the Midnight tab has its own footer that says which.
          tab === 'midnight' || utxos === null ? null : <EmptyState icon="wallet" title={t('cardanoUtxos.empty')} />
        }
      />
      <ConsolidatePreview
        outcome={consolidate.preview}
        onConfirm={consolidate.confirm}
        onDismiss={consolidate.dismiss}
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {flex: 1},
  // The extra bottom padding is not decoration: the shielded card is the last thing in the list and its
  // sync button sat flush against the screen edge, half under the gesture area.
  list: {padding: spacing.spacing16, gap: spacing.spacing12},
  /**
   * The shielded card ends in a button rather than a UTxO row, and `group`'s 4px vertical padding is sized
   * for rows that carry their own — so without this the sync button sat flush against the card's edge.
   */
  shieldedCard: {paddingHorizontal: spacing.spacing16, paddingVertical: spacing.spacing16, gap: spacing.spacing8},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.spacing24},
  group: {paddingHorizontal: spacing.spacing16, paddingVertical: spacing.spacing4},
  summary: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.spacing12,
    paddingHorizontal: spacing.spacing16,
    paddingVertical: spacing.spacing16,
  },
  summaryText: {flex: 1, gap: spacing.spacing2},
  addressBlock: {paddingVertical: spacing.spacing12, gap: spacing.spacing2},
  utxoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.spacing12,
    paddingVertical: spacing.spacing12,
  },
  rowBorder: {borderBottomWidth: 1, borderBottomColor: colors.borderDefaultWeak},
  amountCol: {alignItems: 'flex-end'},
  muted: {color: colors.textAlternative},
}))
