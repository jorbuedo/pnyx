/**
 * Receive — every chain's receive address for the selected wallet group in one
 * place. BTC / EVM / SOL / ADA come from the derive-only addresses persisted at
 * wallet create/restore (read-only here — no lazy derivation); Midnight is the
 * GROUP's own receive address served from storage. Each row shows the chain, a
 * copiable truncated address, and a QR the user can present to a sender.
 *
 * The Midnight IDENTITY address stays out of here: the identity wallet is not
 * a funds wallet (identity/wallet split) and its address lives in the Id tab.
 * The Midnight row below belongs to the selected funds group (dev-lead
 * decision 2026-07-18: funds wallets receive on ADA/BTC/EVM/SOL + Midnight).
 *
 * @module
 */

import {
  BITCOIN_MAINNET,
  CARDANO_MAINNET,
  type ChainId,
  ETHEREUM_MAINNET,
  MIDNIGHT_MAINNET,
  SOLANA_MAINNET,
} from '@pnyx/config'
import type {DeriveOnlyChain} from '@pnyx/wallet'
import {useCallback, useEffect, useState} from 'react'
import {ActivityIndicator, Linking, Share, View} from 'react-native'
import {StyleSheet, withUnistyles} from 'react-native-unistyles'
import {Accordion} from '../../components/Accordion'
import {Address} from '../../components/Address'
import {Button, ButtonIcon} from '../../components/Buttons'
import {ChainRow} from '../../components/ChainRow'
import {Modal} from '../../components/Modal'
import {QRCard} from '../../components/QRCard'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {Typography} from '../../components/Typography'
import {UniIcon} from '../../components/UniIcon'
import {ValueBox} from '../../components/ValueBox'
import {DERIVE_ONLY_ADDRESS_EXPLORERS} from '../../hooks/explorerConfig'
import {getExplorerName, useExplorerPreference} from '../../hooks/useExplorerPreference'
import {useMidnightShieldedBalance} from '../../hooks/useMidnightShieldedBalance'
import {logger} from '../../logger'
import {useConfig, useCopy, useI18n, useWalletAddress, useWalletList} from '../../providers'
import {MIDNIGHT_EXPLORER_NAME, midnightExplorerAddressUrl} from '../../services/midnight/explorer'
import {midnightFundsNetwork} from '../../services/midnight/networks'
import {RequestFundsModal} from './RequestFundsModal'

const QR_SIZE = 200

/** Trailing QR action with the shared 24-box icon metrics, theme-tinted. */
const QrButtonIcon = withUnistyles(ButtonIcon, (theme) => ({
  iconProps: {color: theme.colors.iconDefault},
}))

type ReceiveChainKey = DeriveOnlyChain | 'midnight'

type ReceiveRow = {
  readonly key: DeriveOnlyChain
  readonly chain: ChainId
  readonly nameKey: string
  readonly address: string
}

type QrTarget = {
  readonly key: ReceiveChainKey
  readonly name: string
  readonly address: string
  /** Which Midnight address this is — only the unshielded one has an explorer page. */
  readonly midnightKind?: MidnightKind
}

type DeriveRow = {readonly key: DeriveOnlyChain; readonly chain: ChainId; readonly nameKey: string}

/** Chains the wallet actually carries: a balance, a send flow, history. */
const PRIMARY_ROWS: readonly DeriveRow[] = [{key: 'cardano', chain: CARDANO_MAINNET, nameKey: 'wallets.chains.cardano'}]

/**
 * Chains the wallet can only *derive* an address on (the multi-chain pivot: address + on-chain ownership
 * proofs, no spending and no balance).
 *
 * ⚠️ **Behind a collapsed accordion, at the end** (Jordi, 2026-08-20). Listed flat beside Cardano and
 * Midnight they read as five equally-supported chains, which invites funding an address nothing in the app
 * can then act on — but they are still the addresses the ownership proofs use, so hiding them outright
 * would make a real capability unreachable. Collapsed is the honest middle: present, and evidently not
 * the main event.
 */
const DERIVE_ONLY_ROWS: readonly DeriveRow[] = [
  {key: 'bitcoin', chain: BITCOIN_MAINNET, nameKey: 'wallets.chains.bitcoin'},
  {key: 'evm', chain: ETHEREUM_MAINNET, nameKey: 'wallets.chains.ethereum'},
  {key: 'solana', chain: SOLANA_MAINNET, nameKey: 'wallets.chains.solana'},
]

/**
 * The group's three Midnight addresses, in display order. Slots follow
 * `MIDNIGHT_RECEIVE_ADDRESS_SLOTS` (night 0, dust 1, shielded 2); the night
 * slot is the unshielded/canonical address.
 */
const MIDNIGHT_KINDS = [
  {kind: 'unshielded', slot: 0, labelKey: 'receive.midnightUnshielded'},
  {kind: 'shielded', slot: 2, labelKey: 'receive.midnightShielded'},
  {kind: 'dust', slot: 1, labelKey: 'receive.midnightDust'},
] as const

type MidnightKind = (typeof MIDNIGHT_KINDS)[number]['kind']

export function ReceiveScreen() {
  const {t} = useI18n()
  const {network} = useConfig()
  const {copy} = useCopy()
  const {getDeriveOnlyAddresses, getReceiveAddress} = useWalletAddress()
  const {selectedWalletGroup} = useWalletList()
  // Midnight addresses are seed-derived and persisted at creation, so only
  // seed-backed (software) wallets have them — a funds wallet stores them
  // without listing Midnight as a group chain. Hardware, read-only and shared
  // wallets have no seed, so skip the derivation (it just fails per-slot and
  // logs).
  const groupId = selectedWalletGroup?.groupId
  const primaryWallet = selectedWalletGroup?.primaryWallet
  const hasMidnight =
    primaryWallet !== undefined &&
    primaryWallet.isHardware !== true &&
    primaryWallet.implementation !== 'readOnly' &&
    primaryWallet.source !== 'multisig'
  const {explorerId, getExplorerUrl} = useExplorerPreference()

  const [addresses, setAddresses] = useState<Partial<Record<DeriveOnlyChain, string>>>({})
  const [midnight, setMidnight] = useState<Partial<Record<MidnightKind, string>>>({})
  // Shielded only, and only as a coin count. This screen hands out addresses; a *balance* belongs in the
  // asset and activity surfaces, where a Midnight holding sits beside a Cardano one under a network badge
  // rather than in a per-address line here.
  const shielded = useMidnightShieldedBalance()
  const [loading, setLoading] = useState(true)
  const [qr, setQr] = useState<QrTarget | null>(null)
  /** The Cardano address a funds request is being composed for, or `null`. */
  const [requestAddress, setRequestAddress] = useState<string | null>(null)

  /**
   * Explorer deep-link + display name for an address on the given chain, or
   * null when there is none to give — absence, not a fabricated link.
   */
  const explorerFor = useCallback(
    (target: QrTarget): {readonly name: string; readonly url: string} | null => {
      if (target.key === 'midnight') {
        // Only the unshielded address has a page: a shielded address has no on-chain presence to browse
        // (that is the point of it) and a DUST address is a registration target, not a ledger account.
        if (target.midnightKind !== 'unshielded') return null
        const url = midnightExplorerAddressUrl(midnightFundsNetwork(network), target.address)
        return url === null ? null : {name: MIDNIGHT_EXPLORER_NAME, url}
      }
      return target.key === 'cardano'
        ? {name: getExplorerName(explorerId), url: getExplorerUrl('address', target.address)}
        : {
            name: DERIVE_ONLY_ADDRESS_EXPLORERS[target.key].name,
            url: `${DERIVE_ONLY_ADDRESS_EXPLORERS[target.key].addressUrl}${target.address}`,
          }
    },
    [explorerId, getExplorerUrl, network],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    const load = async () => {
      const derived = await getDeriveOnlyAddresses().catch((e) => {
        logger.warn('Derive-only address read failed; those chains show no address', {
          origin: 'ReceiveScreen',
          error: String(e),
        })
        return {} as Partial<Record<DeriveOnlyChain, string>>
      })
      // The group's own Midnight addresses (unshielded/shielded/dust slots),
      // persisted at create/restore. A missing slot drops that line rather
      // than faking one (older group, storage miss).
      const midnightEntries = hasMidnight
        ? await Promise.all(
            MIDNIGHT_KINDS.map(async ({kind, slot}) => {
              // The group is passed explicitly rather than left to the service's own selection. Relying on
              // that selection is why this silently rendered nothing: a wallet the app knows about is not
              // necessarily one the service has been told to *select* (an E2E-restored group is exactly
              // that), and the read then failed with "requires groupId and chainId" behind a catch.
              const address = await getReceiveAddress({
                ...(groupId === undefined ? {} : {groupId}),
                chainId: MIDNIGHT_MAINNET,
                addressIndex: slot,
              }).catch((error: unknown) => {
                // Logged, not silently dropped. A missing slot is legitimate (an older group), but
                // swallowing the reason made an empty Midnight section impossible to tell apart from a
                // broken read — which cost a debugging session.
                logger.warn('midnight receive address unavailable', {
                  origin: 'ReceiveScreen',
                  kind,
                  slot,
                  error: String(error),
                })
                return undefined
              })
              return [kind, address] as const
            }),
          )
        : []
      if (cancelled) return
      setAddresses(derived)
      setMidnight(Object.fromEntries(midnightEntries.filter(([, address]) => address !== undefined)))
    }
    void load().finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => {
      cancelled = true
    }
  }, [getDeriveOnlyAddresses, getReceiveAddress, groupId, hasMidnight])

  const onShare = useCallback(
    async (target: {readonly name: string; readonly address: string}) => {
      try {
        await Share.share({message: target.address, title: t('receive.shareTitle', {chainName: target.name})})
      } catch (e: unknown) {
        // Ordinarily the user dismissing the OS share sheet. ⚠️ This screen already cost a
        // debugging session by swallowing three rejections — see CLAUDE.md.
        logger.debug('Share sheet closed without sharing the address', {
          origin: 'ReceiveScreen',
          chain: target.name,
          error: String(e),
        })
      }
    },
    [t],
  )

  const resolve = (source: readonly DeriveRow[]): ReceiveRow[] =>
    source.flatMap((r) => {
      const address = addresses[r.key]
      return address !== undefined ? [{key: r.key, chain: r.chain, nameKey: r.nameKey, address}] : []
    })
  const rows = resolve(PRIMARY_ROWS)
  const deriveOnlyRows = resolve(DERIVE_ONLY_ROWS)

  /** One chain row. Shared so the accordion's rows are the same rows, not a second rendering of them. */
  const chainRow = (r: ReceiveRow) => {
    const name = t(r.nameKey as 'wallets.chains.cardano')
    return (
      <ChainRow
        key={r.chain}
        chain={r.chain}
        name={name}
        onPress={() => setQr({key: r.key, name, address: r.address})}
        subtitleContent={<Address address={r.address} showModal={false} />}
        rightAlignTop
        right={
          <QrButtonIcon
            icon="qr"
            size="sm"
            variant="naked"
            onPress={() => setQr({key: r.key, name, address: r.address})}
            testID={`receive-qr-${r.chain}`}
          />
        }
        testID={`receive-row-${r.chain}`}
      >
        {/* Cardano only: the request link names a CAIP-2 chain and a send flow that can read it back, and
            Cardano is the only chain here with both. The others get the plain address above. */}
        {r.key === 'cardano' && (
          <Button
            variant="secondary"
            size="sm"
            label={t('receive.request.action')}
            onPress={() => setRequestAddress(r.address)}
            testID="receive-request-funds"
          />
        )}
      </ChainRow>
    )
  }

  const midnightKinds = MIDNIGHT_KINDS.filter(({kind}) => midnight[kind] !== undefined)

  return (
    <SafeAreaViewWrapper edges={['bottom']} scrollable contentContainerStyle={styles.body}>
      <Typography variant="bodySm_regular" style={styles.hint}>
        {t('receive.hint')}
      </Typography>

      {loading ? (
        <View style={styles.center}>
          <ActivityIndicator />
        </View>
      ) : (
        rows.map(chainRow)
      )}

      {!loading && midnightKinds.length > 0 && (
        <ChainRow chain={MIDNIGHT_MAINNET} name={t('wallets.chains.midnight')} testID="receive-row-midnight">
          {midnightKinds.map(({kind, labelKey}) => {
            const address = midnight[kind]
            if (address === undefined) return null
            const name = `${t('wallets.chains.midnight')} · ${t(labelKey)}`
            return (
              <View key={kind} style={styles.midnightKind}>
                <View style={styles.midnightKindHeader}>
                  <Typography variant="bodyXs_medium" style={styles.midnightKindLabel}>
                    {t(labelKey)}
                  </Typography>
                  <QrButtonIcon
                    icon="qr"
                    size="sm"
                    variant="naked"
                    onPress={() => setQr({key: 'midnight', name, address, midnightKind: kind})}
                    testID={`receive-qr-midnight-${kind}`}
                  />
                </View>
                {/* Its own dial: this row is full-card-width with only a copy icon beside it, so it
                    takes a longer lead than the chain rows above, which also carry an icon and a
                    name. Both are shorter than the default 30 for the same reason — an overflowing
                    pre-sliced lead makes the platform add a *second* ellipsis after ours. */}
                <Address address={address} showModal={false} />
                {kind === 'shielded' && shielded.balances !== null && (
                  <Typography variant="bodyXs_regular" style={styles.midnightKindLabel}>
                    {shielded.balances.length === 0
                      ? t('receive.midnightShieldedEmpty')
                      : t('receive.midnightShieldedHeld', {count: shielded.balances.length})}
                  </Typography>
                )}
              </View>
            )
          })}
        </ChainRow>
      )}

      {/* Address-only chains, collapsed. Present because the ownership proofs use these addresses, and
          collapsed because listing them flat beside Cardano and Midnight reads as five supported chains. */}
      {!loading && deriveOnlyRows.length > 0 && (
        <Accordion
          title={t('receive.otherChains')}
          description={t('receive.otherChainsHint')}
          testID="receive-derive-only"
        >
          {/* The screen's `body` gap only reaches the wrapper's own children, so rows nested in here need
              their own — otherwise the three sit flush against each other. */}
          <View style={styles.accordionRows}>{deriveOnlyRows.map(chainRow)}</View>
        </Accordion>
      )}

      <Modal
        visible={qr !== null}
        onClose={() => setQr(null)}
        position="bottom"
        title={qr !== null ? t('receive.qrTitle', {chain: qr.name}) : undefined}
        testID="receive-qr-modal"
      >
        {qr !== null && (
          <View style={styles.qrContainer}>
            <QRCard value={qr.address} size={QR_SIZE} testID="receive-qr-code" />
            <ValueBox label={t('receive.chainAddress', {chainName: qr.name})} value={qr.address} />
            <View style={styles.networkWarn}>
              <UniIcon
                name="warning"
                width={14}
                height={14}
                uniProps={(theme) => ({color: theme.colors.warningDefault})}
              />
              <Typography variant="bodyXs_regular" style={styles.networkWarnText}>
                {t('receive.sendOnlyWarning', {chainName: qr.name})}
              </Typography>
            </View>
            <View style={styles.qrActions}>
              <Button
                variant="primary"
                label={t('receive.copyAddress')}
                leftIcon="copy"
                fullWidth
                onPress={() => copy({text: qr.address, feedback: t('receive.addressCopied')})}
                testID="receive-modal-copy"
              />
              <Button
                variant="secondary"
                label={t('receive.share')}
                leftIcon="shareOutline"
                fullWidth
                onPress={() => void onShare(qr)}
                testID="receive-modal-share"
              />
              {(() => {
                const explorer = explorerFor(qr)
                return explorer !== null ? (
                  <Button
                    variant="nakedDefault"
                    label={t('receive.viewOnExplorer', {explorerName: explorer.name})}
                    leftIcon="arrowUpRight"
                    fullWidth
                    onPress={() => void Linking.openURL(explorer.url)}
                    testID="receive-modal-explorer"
                  />
                ) : null
              })()}
            </View>
          </View>
        )}
      </Modal>

      <RequestFundsModal
        visible={requestAddress !== null}
        onClose={() => setRequestAddress(null)}
        addressBech32={requestAddress ?? ''}
        onShare={(link) => {
          void Share.share({message: link, title: t('receive.request.title')})
        }}
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  body: {
    padding: theme.spacing.spacing16,
    gap: theme.spacing.spacing12,
  },
  accordionRows: {
    gap: theme.spacing.spacing12,
  },
  hint: {
    color: theme.colors.textMuted,
  },
  midnightKind: {
    gap: theme.spacing.spacing2,
  },
  midnightKindLabel: {
    color: theme.colors.textMuted,
    textTransform: 'uppercase',
    letterSpacing: 0.7,
  },
  midnightKindHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.spacing8,
  },
  center: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing.spacing48,
  },
  qrContainer: {
    alignItems: 'center',
    gap: theme.spacing.spacing16,
    paddingTop: theme.spacing.spacing8,
  },
  networkWarn: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: theme.spacing.spacing6,
    paddingHorizontal: theme.spacing.spacing4,
    width: '100%',
  },
  networkWarnText: {
    flex: 1,
    color: theme.colors.textAlternative,
  },
  qrActions: {
    width: '100%',
    gap: theme.spacing.spacing8,
  },
}))
