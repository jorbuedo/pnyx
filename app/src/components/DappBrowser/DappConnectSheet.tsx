/**
 * Bottom-sheet approval for a dApp **connection** request — a permission grant,
 * not a signature.
 *
 * No signing decision lives here. `signTx` and `signData` both route to
 * `TxReviewScreen`, so the user sees the bytes before any key is used (Phase 16
 * item 41; `product/STATUS.md` → "One review surface for all signing"). Keep it
 * that way: a sheet is the wrong surface for consenting to a signature, because
 * it has nowhere to show what is being signed.
 *
 * @module
 */

import {DEFAULT_SESSION_TTL_MS} from '@pnyx/dapp-connector'
import {useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import type {PendingDappRequest} from '../../hooks/useDappConnector'
import {logger} from '../../logger'
import {useI18n, useWalletList} from '../../providers'
import {CHAIN_TYPE_LABELS} from '../../utils/chain-type-label'
import {Modal} from '../Modal'
import {SegmentedControl} from '../SegmentedControl'
import {Typography} from '../Typography'
import {DappConnectTarget} from './DappConnectTarget'

const styles = StyleSheet.create(({spacing, colors}) => ({
  body: {gap: spacing.spacing12},
  permissions: {gap: spacing.spacing8, paddingTop: spacing.spacing4},
  permissionRow: {flexDirection: 'row', gap: spacing.spacing8},
  bullet: {color: colors.textAlternative},
  duration: {gap: spacing.spacing8, paddingTop: spacing.spacing8},
}))

export type DappConnectSheetProps = {
  readonly request: PendingDappRequest | null
  /** `ttlMs` is the grant lifetime the user picked (`null` = until revoked). */
  readonly onApprove: (ttlMs: number | null) => void
  readonly onReject: () => void
}

/**
 * The offered lifetimes as `SegmentedControl` values. "Until revoked" has no
 * numeric form, so the control speaks these ids and maps back on selection.
 */
const TTL_BY_ID = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  never: null,
} as const satisfies Record<string, number | null>

type TtlId = keyof typeof TTL_BY_ID

const ttlIdOf = (ttlMs: number | null): TtlId => (ttlMs === null ? 'never' : ttlMs <= TTL_BY_ID['24h'] ? '24h' : '7d')

/** How long the connection should last — the shared segmented control. */
const DurationPicker = ({selected, onSelect}: {selected: number | null; onSelect: (ttlMs: number | null) => void}) => {
  const {t} = useI18n()
  return (
    <View style={styles.duration}>
      <Typography variant="bodyMd_medium">{t('txReview.dapp.durationTitle')}</Typography>
      <SegmentedControl
        options={[
          {label: t('txReview.dapp.duration.day'), value: '24h'},
          {label: t('txReview.dapp.duration.week'), value: '7d'},
          {label: t('txReview.dapp.duration.never'), value: 'never'},
        ]}
        value={ttlIdOf(selected)}
        onChange={(id: TtlId) => onSelect(TTL_BY_ID[id])}
        testID="dapp-duration"
      />
    </View>
  )
}

const originLabel = (origin: string): string => {
  try {
    return new URL(origin).host
  } catch (e: unknown) {
    // ⚠️ This is the label the user reads before deciding to connect. The raw string is the
    // honest fallback, but an origin we cannot parse is worth knowing about on this surface.
    logger.warn('dApp origin could not be parsed for the connect sheet; showing it raw', {
      origin: 'DappConnectSheet',
      value: origin,
      error: String(e),
    })
    return origin
  }
}

/**
 * The connection request's body — permissions, target account, and how long the grant lasts.
 */
const ConnectBody = ({ttlMs, onTtl}: {ttlMs: number | null; onTtl: (ms: number | null) => void}) => {
  const {t} = useI18n()
  const {selectedWalletGroup, selectedAccountIndex} = useWalletList()
  return (
    <View style={styles.permissions}>
      <Typography variant="bodyMd_medium">{t('txReview.dapp.permissionsTitle')}</Typography>
      <View style={styles.permissionRow}>
        <Typography variant="bodyMd_regular" style={styles.bullet}>
          {'•'}
        </Typography>
        <Typography variant="bodyMd_regular">{t('txReview.dapp.permissionAddresses')}</Typography>
      </View>
      <View style={styles.permissionRow}>
        <Typography variant="bodyMd_regular" style={styles.bullet}>
          {'•'}
        </Typography>
        <Typography variant="bodyMd_regular">{t('txReview.dapp.permissionSign')}</Typography>
      </View>
      <DappConnectTarget groupId={selectedWalletGroup?.groupId ?? null} accountIndex={selectedAccountIndex} />
      <DurationPicker selected={ttlMs} onSelect={onTtl} />
    </View>
  )
}

/** A signing request's body: what is being signed, and that it is not a transaction. */
const SignMessageBody = ({data}: {data: string}) => {
  const {t} = useI18n()
  return (
    <View style={styles.permissions}>
      <Typography variant="bodyMd_medium">{t('txReview.dapp.signMessageWhat')}</Typography>
      {/* Verbatim and selectable: the user is being asked to sign exactly this, so a summary would be
          the wrong thing to show. */}
      <Typography variant="bodySm_regular" style={styles.bullet} selectable>
        {data}
      </Typography>
      <Typography variant="bodySm_regular" style={styles.bullet}>
        {t('txReview.dapp.signMessageNotATransaction')}
      </Typography>
    </View>
  )
}

/**
 * A secret-derivation request's body: which label, and what the answer can and cannot do.
 *
 * The label is shown verbatim because it selects *which* secret — two labels are two independent
 * secrets, and a user re-approving for a site should be able to see that it changed.
 */
const AppSecretBody = ({domain}: {domain: string}) => {
  const {t} = useI18n()
  return (
    <View style={styles.permissions}>
      <Typography variant="bodyMd_medium">{t('txReview.dapp.appSecretWhat')}</Typography>
      <Typography variant="bodySm_regular" style={styles.bullet} selectable>
        {domain}
      </Typography>
      <Typography variant="bodySm_regular" style={styles.bullet}>
        {t('txReview.dapp.appSecretExplainer')}
      </Typography>
    </View>
  )
}

/**
 * One sheet for both requests.
 *
 * ⚠️ **A single `Modal` element, chosen by props rather than by an early return.** Returning a second
 * `Modal` from a branch swaps one instance for another at the same position in the tree, and that
 * crashed Fabric's mount outright — `SIGSEGV` in `MountingCoordinator::pullTransaction`, with the app
 * dying the moment the browser screen rendered. Only the body varies; the modal itself does not.
 */
export const DappConnectSheet = ({request, onApprove, onReject}: DappConnectSheetProps) => {
  const {t} = useI18n()
  const visible = request !== null
  const host = request ? originLabel(request.origin) : ''
  const [ttlMs, setTtlMs] = useState<number | null>(DEFAULT_SESSION_TTL_MS)
  const signing = request?.kind === 'signMessage'
  const appSecret = request?.kind === 'appSecret'
  const origin = host || t('txReview.dapp.unknownOrigin')

  return (
    <Modal
      visible={visible}
      onClose={onReject}
      position="bottom"
      showDragIndicator
      // The permissions, the wallet chooser and the duration picker together outrun a phone
      // screen the moment the chooser is open. `ModalActions` renders outside the ScrollView,
      // so Cancel/Connect stay put while the rest moves.
      scrollable
      title={
        appSecret
          ? t('txReview.dapp.appSecretTitle')
          : signing
            ? t('txReview.dapp.signMessageTitle')
            : t('txReview.dapp.connectTitle')
      }
      description={
        appSecret
          ? t('txReview.dapp.appSecretBody', {origin})
          : signing
            ? t('txReview.dapp.signMessageBody', {origin})
            : t('txReview.dapp.connectBody', {
                origin,
                chain: request?.kind === 'connect' ? CHAIN_TYPE_LABELS[request.chainType] : '',
              })
      }
      actions={[
        {label: t('common.buttons.cancel'), onPress: onReject, variant: 'secondary'},
        {
          label: appSecret
            ? t('txReview.dapp.appSecretApprove')
            : signing
              ? t('txReview.dapp.signMessageApprove')
              : t('txReview.dapp.connectApprove'),
          // Approving a signature or a derivation grants nothing ongoing, so there is no lifetime.
          onPress: () => onApprove(signing || appSecret ? null : ttlMs),
          variant: 'primary',
        },
      ]}
      actionsLayout="horizontal"
    >
      <View style={styles.body}>
        {request?.kind === 'signMessage' ? (
          <SignMessageBody data={request.data} />
        ) : request?.kind === 'appSecret' ? (
          <AppSecretBody domain={request.domain} />
        ) : (
          <ConnectBody ttlMs={ttlMs} onTtl={setTtlMs} />
        )}
      </View>
    </Modal>
  )
}
