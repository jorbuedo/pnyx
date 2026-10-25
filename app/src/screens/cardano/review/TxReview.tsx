/**
 * `TxReview` — the single multi-tab Cardano transaction review, used for both
 * the signing-confirm flow (`mode="confirm"`) and the history detail view
 * (`mode="detail"`). Presentation-only: it renders a `ReviewedTransaction`
 * (enriched with token metadata + fiat) and owns no signing/navigation — the
 * host screen wraps it with the CTA/ceremony.
 *
 * @module
 */

import type {ReviewedTransaction, TransactionWarning} from '@pnyx/tx-review'
import {useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {TabsWrapper} from '../../../components/Tabs'
import {useI18n} from '../../../providers'
import type {SignatureStatus} from '../../../services/cardano/cosign/types'
import {ReviewEnrichmentProvider} from './enrichment'
import {
  ContractsTab,
  DetailsTab,
  OperationsTab,
  OverviewTab,
  type ReviewTabKey,
  SignaturesTab,
  UtxosTab,
  visibleTabs,
} from './tabs'

const styles = StyleSheet.create(({spacing}) => ({
  body: {paddingHorizontal: spacing.spacing4},
}))

const TAB_LABEL_KEY: Record<ReviewTabKey, string> = {
  overview: 'txReview.tabs.overview',
  utxos: 'txReview.tabs.utxos',
  operations: 'txReview.tabs.operations',
  contracts: 'txReview.tabs.contracts',
  signatures: 'txReview.tabs.signatures',
  details: 'txReview.tabs.details',
}

export type TxReviewMode = 'confirm' | 'detail'

const TabContent = ({
  tab,
  reviewed,
  signatureStatus,
  mode,
  expectedWarnings,
}: {
  readonly tab: ReviewTabKey
  readonly reviewed: ReviewedTransaction
  readonly signatureStatus?: SignatureStatus | undefined
  readonly mode: TxReviewMode
  readonly expectedWarnings?: ReadonlySet<TransactionWarning> | undefined
}) => {
  switch (tab) {
    case 'overview':
      return <OverviewTab reviewed={reviewed} mode={mode} expectedWarnings={expectedWarnings} />
    case 'utxos':
      return <UtxosTab reviewed={reviewed} />
    case 'operations':
      return <OperationsTab reviewed={reviewed} />
    case 'contracts':
      return <ContractsTab reviewed={reviewed} />
    case 'signatures':
      return <SignaturesTab reviewed={reviewed} signatureStatus={signatureStatus} />
    case 'details':
      return <DetailsTab reviewed={reviewed} mode={mode} />
  }
}

export const TxReview = ({
  reviewed,
  mode = 'confirm',
  signatureStatus,
  expectedWarnings,
}: {
  readonly reviewed: ReviewedTransaction
  readonly mode?: TxReviewMode
  readonly signatureStatus?: SignatureStatus | undefined
  /** Warnings the producer declared definitional for what it built — see `warningKeysForMode`. */
  readonly expectedWarnings?: ReadonlySet<TransactionWarning> | undefined
  /**
   * The unsigned body's CBOR, when the producer has it — offered as a copyable
   * row in Details so the exact bytes can be decoded elsewhere. Absent for a
   * settled transaction read back from an indexer, which never carries it.
   */
}) => {
  const tabs = useMemo(() => {
    const base = visibleTabs(reviewed)
    // A multisig/multiparty tx forces the Signatures tab even when the body has
    // no key-hash required-signers (script-based).
    return signatureStatus && !base.includes('signatures')
      ? [...base.slice(0, -1), 'signatures' as const, ...base.slice(-1)]
      : base
  }, [reviewed, signatureStatus])
  const {t} = useI18n()
  const [active, setActive] = useState<ReviewTabKey>('overview')

  // No hero. The transaction *type* is the screen title in both modes now, and
  // the coin figure it used to shout was already itemised directly beneath it in
  // `YOUR WALLET` — a heading and a duplicate of the first row under it. This is
  // the rule the history detail always followed; the signing flow was the odd one.
  return (
    <ReviewEnrichmentProvider reviewed={reviewed}>
      <TabsWrapper
        tabs={tabs.map((key) => ({key, label: t(TAB_LABEL_KEY[key] as never)}))}
        activeTab={active}
        onTabChange={(k) => setActive(k as ReviewTabKey)}
        scrollable
      />

      <View style={styles.body}>
        <TabContent
          tab={tabs.includes(active) ? active : 'overview'}
          reviewed={reviewed}
          signatureStatus={signatureStatus}
          mode={mode}
          expectedWarnings={expectedWarnings}
        />
      </View>
    </ReviewEnrichmentProvider>
  )
}
