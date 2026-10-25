/**
 * Connected dApps — list and revoke the sites allowed to see this wallet.
 *
 * Reads the session store this runtime shares with its dApp connector (the
 * extension's `chrome.storage`, otherwise the in-app browser's platform store),
 * so it covers both surfaces. Row assembly is pure and lives in
 * `connected-dapps-rows.ts`. See `docs/CONNECTED_DAPPS.md`.
 *
 * @module
 */

import type {DappSession} from '@pnyx/dapp-connector'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {DAPP_SESSIONS_KEY} from '../../../extension/dapp/protocol'
import {Button} from '../../components/Buttons'
import {EmptyState} from '../../components/EmptyState'
import {Skeleton} from '../../components/Loaders'
import {Modal} from '../../components/Modal'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SettingsGroup} from '../../components/SettingsGroup'
import {SettingsRow} from '../../components/SettingsRow'
import {UniIcon} from '../../components/UniIcon'
import {useToast} from '../../hooks/useToast'
import {logger} from '../../logger'
import {isExtension} from '../../platform/extension/runtime'
import {useI18n, useWalletList} from '../../providers'
import {listDappSessions, revokeAllDappSessions, revokeDappSession} from '../../services/dapp/session-access'
import {CHAIN_TYPE_LABELS} from '../../utils/chain-type-label'
import {buildConnectedDappRows} from './connected-dapps-rows'

type LoadState =
  | {readonly status: 'loading'}
  | {readonly status: 'error'}
  | {readonly status: 'ready'; readonly sessions: readonly DappSession[]}

export function ConnectedDappsScreen() {
  const {t, formatRelativeTime} = useI18n()
  const {showToast} = useToast()
  const {walletGroups} = useWalletList()
  const [state, setState] = useState<LoadState>({status: 'loading'})
  const [confirmingAll, setConfirmingAll] = useState(false)

  const load = useCallback(async () => {
    try {
      const sessions = await listDappSessions()
      setState({status: 'ready', sessions})
    } catch (e: unknown) {
      logger.warn('Connected dApp sessions could not be listed', {origin: 'ConnectedDappsScreen', error: String(e)})
      setState({status: 'error'})
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  // Another context can mutate sessions while this screen is open: the worker
  // prunes on expiry, and an approval can land from the popup.
  useEffect(() => {
    if (!isExtension || typeof chrome === 'undefined' || !chrome.storage?.onChanged) return
    const listener = (changes: {[key: string]: chrome.storage.StorageChange}, area: string) => {
      if (area === 'local' && DAPP_SESSIONS_KEY in changes) void load()
    }
    chrome.storage.onChanged.addListener(listener)
    return () => chrome.storage.onChanged.removeListener(listener)
  }, [load])

  const walletNames = useMemo(
    () => new Map((walletGroups ?? []).map((group) => [group.groupId, group.name])),
    [walletGroups],
  )

  const sessions = state.status === 'ready' ? state.sessions : []
  const rows = useMemo(() => buildConnectedDappRows(sessions, walletNames, Date.now()), [sessions, walletNames])

  const describe = (row: (typeof rows)[number]): string =>
    [
      CHAIN_TYPE_LABELS[row.chainType],
      // A grant is per-account, so the account belongs next to the wallet name.
      row.walletName === null
        ? null
        : `${row.walletName} · ${t('manageAccounts.accountLabel', {index: row.accountIndex})}`,
      row.expiry.kind === 'never'
        ? t('settings.connectedDapps.expiresNever')
        : t('settings.connectedDapps.expiresIn', {
            when: formatRelativeTime(row.expiry.value, row.expiry.unit),
          }),
    ]
      .filter((part): part is string => part !== null)
      .join(' · ')

  const handleRevoke = async (session: DappSession, origin: string) => {
    try {
      await revokeDappSession(session)
      showToast({variant: 'success', message: t('settings.connectedDapps.disconnected', {origin})})
    } catch (e: unknown) {
      // A revoke the user believes succeeded and one that failed differ only in a toast, and the
      // session is still live either way.
      logger.warn('dApp session could not be revoked', {origin: 'ConnectedDappsScreen', dapp: origin, error: String(e)})
      showToast({variant: 'error', message: t('settings.connectedDapps.disconnectFailed', {origin})})
    }
    await load()
  }

  const handleRevokeAll = async () => {
    setConfirmingAll(false)
    try {
      await revokeAllDappSessions()
    } catch (e: unknown) {
      logger.warn('dApp sessions could not all be revoked; some may still be live', {
        origin: 'ConnectedDappsScreen',
        error: String(e),
      })
      showToast({variant: 'error', message: t('settings.connectedDapps.disconnectAllFailed')})
    }
    await load()
  }

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.scrollContent}
    >
      {state.status === 'loading' ? (
        <View style={styles.skeletonGroup}>
          <Skeleton show height={64} radius={8}>
            {null}
          </Skeleton>
          <Skeleton show height={64} radius={8}>
            {null}
          </Skeleton>
        </View>
      ) : null}

      {state.status === 'error' ? (
        <View style={styles.centered}>
          <EmptyState
            icon="warning"
            title={t('settings.connectedDapps.loadFailed')}
            action={{label: t('settings.connectedDapps.retry'), onPress: () => void load()}}
            testID="connected-dapps-error"
          />
        </View>
      ) : null}

      {state.status === 'ready' && rows.length === 0 ? (
        <View style={styles.centered}>
          <EmptyState
            icon="globe"
            title={t('settings.connectedDapps.emptyTitle')}
            description={t('settings.connectedDapps.emptyBody')}
            testID="connected-dapps-empty"
          />
        </View>
      ) : null}

      {state.status === 'ready' && rows.length > 0 ? (
        <>
          <SettingsGroup label={t('settings.connectedDapps.sectionLabel')}>
            {rows.map((row, index) => {
              const session = sessions.find((s) => s.id === row.id)
              return (
                <SettingsRow
                  key={row.id}
                  label={row.host}
                  description={describe(row)}
                  leftIcon="globe"
                  iconColor="textMuted"
                  size="lg"
                  showBorder={index < rows.length - 1}
                  testID={`connected-dapp-${row.host}`}
                >
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.connectedDapps.a11yDisconnect', {origin: row.origin})}
                    hitSlop={12}
                    style={styles.revokeButton}
                    onPress={() => session && void handleRevoke(session, row.origin)}
                    testID={`connected-dapp-revoke-${row.host}`}
                  >
                    <UniIcon name="close" size="sm" uniProps={(theme) => ({color: theme.colors.errorDefault})} />
                  </Pressable>
                </SettingsRow>
              )
            })}
          </SettingsGroup>

          {rows.length > 1 ? (
            <Button
              label={t('settings.connectedDapps.disconnectAll')}
              variant="secondary"
              size="lg"
              fullWidth
              onPress={() => setConfirmingAll(true)}
              testID="connected-dapps-disconnect-all"
            />
          ) : null}
        </>
      ) : null}

      <Modal
        position="center"
        visible={confirmingAll}
        onClose={() => setConfirmingAll(false)}
        title={t('settings.connectedDapps.disconnectAllTitle')}
        description={t('settings.connectedDapps.disconnectAllBody')}
        actions={[
          {label: t('settings.connectedDapps.cancel'), variant: 'secondary', onPress: () => setConfirmingAll(false)},
          {label: t('settings.connectedDapps.disconnectAll'), isError: true, onPress: () => void handleRevokeAll()},
        ]}
        testID="connected-dapps-disconnect-all-confirm"
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create(({spacing}) => ({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.spacing16,
    paddingTop: spacing.spacing16,
    gap: spacing.spacing16,
  },
  skeletonGroup: {
    gap: spacing.spacing12,
  },
  centered: {
    paddingTop: spacing.spacing32,
  },
  revokeButton: {
    padding: spacing.spacing8,
  },
}))
