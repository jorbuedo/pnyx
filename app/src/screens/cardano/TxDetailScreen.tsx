/**
 * Cardano transaction detail: the same multi-tab review renderer in
 * `mode="detail"`, plus a copyable tx id and a "view on explorer" link.
 *
 * The transaction is always decoded from its own bytes; the by-hash cache the
 * list primes is rendered first when it has one, so navigation is immediate, and
 * the persisted store answers when the bytes cannot be fetched at all.
 *
 * The screen title is the transaction's type; the review's own hero is suppressed
 * in `detail` mode because the amounts are itemised per party below it.
 *
 * @module
 */

import type {ReviewedTransaction} from '@pnyx/tx-review'
import {Effect} from 'effect'
import {Stack, useLocalSearchParams} from 'expo-router'
import {useEffect, useState} from 'react'
import {Linking, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../components/Buttons'
import {Callout} from '../../components/Callout'
import {Copiable} from '../../components/Copiable'
import {CircleLoader} from '../../components/Loaders'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {Typography} from '../../components/Typography'
import {getCachedHistoryTx} from '../../hooks/useCardanoHistory'
import {useCardanoRail} from '../../hooks/useCardanoRail'
import {useExplorerPreference} from '../../hooks/useExplorerPreference'
import {useModelReady} from '../../hooks/useModelAvailability'
import {logger} from '../../logger'
import {useI18n} from '../../providers'
import {loadCardanoHistoryTx, reviewCardanoTxFromChain} from '../../services/cardano'
import {metadataProtocol, protocolTitle} from '../../services/cardano/metadata/protocol'
import {mergeReviewedTx} from '../../services/cardano/review-merge'
import {truncateWide} from '../../utils/truncate'
import {ExplainTxAction} from './ExplainTxAction'
import {TxReview} from './review'
import {reviewTitleKey} from './review-model'

const styles = StyleSheet.create(({spacing, colors}) => ({
  content: {paddingHorizontal: spacing.spacing16, paddingBottom: spacing.spacing16},
  footer: {paddingVertical: spacing.spacing16, gap: spacing.spacing12},
  idBlock: {gap: spacing.spacing4},
  hash: {flex: 1},
  muted: {color: colors.textAlternative},
  center: {flex: 1, alignItems: 'center', justifyContent: 'center', padding: spacing.spacing24},
}))

/**
 * Whether the wallet is a party to this transaction — decides the "not yours"
 * banner. Ownership already comes out of the review's own grouping, so this asks
 * the IR rather than re-deriving it from addresses.
 */
const isOwnTx = (tx: ReviewedTransaction): boolean =>
  tx.ownGroup.parties.length > 0 || tx.identityGroup.parties.length > 0 || tx.escrowGroup.parties.length > 0

/**
 * Resolve a reviewed tx by hash: render the session cache at once if it holds
 * one, and always decode the transaction's own bytes, replacing the cached
 * summary when that lands. Falls back to the persisted store when the bytes
 * cannot be fetched.
 *
 * The cache is primed by the history list, and short-circuiting on a hit meant
 * arriving from Activity showed strictly less than deep-linking the same hash:
 * the indexer's summary has no witness set, no scripts or collateral, no
 * governance procedures, no CBOR and no phase-2 verdict, so the tabs built over
 * those simply did not appear for the transactions a user is most likely to open.
 * The cached copy is now the first frame, not the final answer.
 *
 * The two producers are merged rather than swapped — see `mergeReviewedTx`; a
 * body carries neither its own hash nor, usually, its network.
 *
 * Decoding the bytes is also what lets ANY on-chain transaction be inspected, not
 * only this wallet's own. `foreign` says the answer came from the indexer rather
 * than our history, so the screen can say so instead of implying it is ours — a
 * cache hit means it IS ours, whatever the current account's tiering makes of it.
 */
const useReviewedTx = (
  hash: string | undefined,
): {tx: ReviewedTransaction | null; loading: boolean; foreign: boolean} => {
  const {rail} = useCardanoRail()
  const cached = hash === undefined ? undefined : getCachedHistoryTx(hash)
  const [loaded, setLoaded] = useState<ReviewedTransaction | null>(null)
  const [foreign, setForeign] = useState(false)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (hash === undefined || rail === null) return
    let active = true
    setLoading(true)
    void Effect.runPromise(
      reviewCardanoTxFromChain(rail, hash).pipe(
        Effect.catchAll((e) => {
          logger.warn('On-chain tx review failed; falling back to stored history', {
            origin: 'TxDetailScreen',
            hash,
            error: String(e),
          })
          return Effect.succeed(null)
        }),
        Effect.flatMap((fromChain) =>
          fromChain !== null
            ? Effect.succeed({
                tx: mergeReviewedTx(fromChain, getCachedHistoryTx(hash)),
                foreign: !isOwnTx(fromChain),
              })
            : loadCardanoHistoryTx(rail, hash).pipe(
                Effect.map((own) => ({tx: own, foreign: false})),
                Effect.catchAll((e) => {
                  logger.warn('Stored tx read failed; the detail screen has nothing to show', {
                    origin: 'TxDetailScreen',
                    hash,
                    error: String(e),
                  })
                  return Effect.succeed({tx: null, foreign: false})
                }),
              ),
        ),
      ),
    )
      .then((r) => {
        if (!active) return
        // A failed decode must not blank a summary already on screen.
        if (r.tx !== null) setLoaded(r.tx)
        setForeign(r.foreign)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [hash, rail])

  return {tx: loaded ?? cached ?? null, loading, foreign: cached !== undefined ? false : foreign}
}

export const TxDetailScreen = () => {
  const {t} = useI18n()
  const {hash} = useLocalSearchParams<{hash: string}>()
  const {getExplorerUrl} = useExplorerPreference()
  const {tx: reviewed, loading, foreign} = useReviewedTx(hash)
  // Settled history only — never the pre-sign review screen, which renders the same
  // `TxReview` from the same IR. A wrong summary is embarrassing here and dangerous
  // there, so the affordance deliberately lives on the screen rather than in the
  // shared component. See docs/mobile-shell-plan.md item 38.
  const modelReady = useModelReady()

  if (reviewed === null) {
    return (
      <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.center}>
        {loading ? (
          <CircleLoader size="md" />
        ) : (
          <Typography variant="bodyMd_regular" style={styles.muted}>
            {t('cardanoActivity.loadError')}
          </Typography>
        )}
      </SafeAreaViewWrapper>
    )
  }

  const explorerUrl = hash !== undefined ? getExplorerUrl('tx', hash) : undefined

  return (
    <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.content}>
      <Stack.Screen
        options={{
          title: protocolTitle(t(`txReview.titles.${reviewTitleKey(reviewed)}` as never), metadataProtocol(reviewed)),
          // Rendered only when a model can actually answer. `null` availability (still
          // resolving) shows nothing rather than a button that vanishes a beat later.
          ...(modelReady
            ? {
                headerRight: () => <ExplainTxAction subject={{legs: [reviewed], messageCount: 0, when: 'settled'}} />,
              }
            : {}),
        }}
      />
      {/* Say whose transaction this is. Without it, a foreign tx rendered in our
          own chrome invites the reader to assume it is theirs. */}
      {foreign ? <Callout variant="info" message={t('cardanoActivity.foreignTx')} /> : null}
      <TxReview reviewed={reviewed} mode="detail" />
      <View style={styles.footer}>
        {hash !== undefined ? (
          <View style={styles.idBlock}>
            <Typography variant="bodySm_regular" style={styles.muted}>
              {t('cardanoActivity.txId')}
            </Typography>
            <Copiable text={hash} feedback={t('common.labels.copied')} testID="tx-id-copy">
              <Typography variant="bodySm_regular" style={styles.hash} numberOfLines={1}>
                {truncateWide(hash)}
              </Typography>
            </Copiable>
          </View>
        ) : null}
        {explorerUrl !== undefined ? (
          <Button
            variant="nakedDefault"
            size="sm"
            label={t('cardanoActivity.viewOnExplorer')}
            rightIcon="arrowUpRight"
            onPress={() => Linking.openURL(explorerUrl)}
            testID="tx-explorer-link"
          />
        ) : null}
      </View>
    </SafeAreaViewWrapper>
  )
}
