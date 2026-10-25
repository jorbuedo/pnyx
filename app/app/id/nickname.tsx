/**
 * Change the name you show.
 *
 * **One `setPrimaryName`, and nothing else.** A nickname is not owned and not unique, so changing it
 * needs no permit, no handle contract and no release — which is why this is its own screen rather
 * than part of `/id/manage`, the surface that deals with a *registered* name and everything that
 * implies. It is reachable with the `handles` vertical off, because the nickname layer is what the
 * mainnet launch ships.
 *
 * ⚠️ **It writes through `writePrimaryName`, the same function the claim chain's last step uses.** A
 * second writer for one field is how the display spelling and the folded one get mixed up — the row
 * carries the case its owner chose, and a reader folds it before comparing.
 *
 * ⚠️ **Awaited here, unlike onboarding.** There the write is deferred so a new user is never blocked
 * on the chain; here the user came specifically to change a name and must be told whether it changed.
 *
 * @module
 */

import {validateHandle} from '@pnyx/contract-client/handle'
import {identityCommitmentOf, identitySkFromForumRoot} from '@pnyx/contract-client/identity'
import {router} from 'expo-router'
import {useCallback, useMemo, useState} from 'react'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../src/components/Buttons'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {StickyFooter} from '../../src/components/StickyFooter'
import {TextInput} from '../../src/components/TextInput'
import {Typography} from '../../src/components/Typography'
import {useHandleActions} from '../../src/hooks/useHandleActions'
import {useToast} from '../../src/hooks/useToast'
import {logger} from '../../src/logger'
import {useI18n, usePnyxSession} from '../../src/providers'
import {REJECTION_KEY} from '../../src/services/handle-rejection-key'
import {identityContractAddressFor} from '../../src/services/identity-contract'
import {clearPendingNickname} from '../../src/services/nickname-pending'
import {writePrimaryName} from '../../src/services/primary-name-write'

const ORIGIN = 'id-nickname'
const TTL_SECS = 3600

export default function NicknameScreen() {
  const {t} = useI18n()
  const {session} = usePnyxSession()
  const {nickname, refresh} = useHandleActions()
  const {showToast} = useToast()
  const [typed, setTyped] = useState(nickname ?? '')
  const [saving, setSaving] = useState(false)

  const trimmed = typed.trim()
  const checked = useMemo(() => (trimmed === '' ? undefined : validateHandle(typed)), [typed, trimmed])
  const rejection = checked !== undefined && !checked.ok ? checked.reason : undefined
  const unchanged = checked?.ok === true && checked.display === nickname

  const save = useCallback(async () => {
    if (checked?.ok !== true || saving) return
    const forumRoot = session?.forumRoot
    const network = session?.network
    if (forumRoot === undefined || network === undefined) {
      showToast({message: t('you.nickname.unavailable'), variant: 'error'})
      return
    }
    setSaving(true)
    const identitySk = identitySkFromForumRoot(forumRoot)
    const contractAddress = await identityContractAddressFor(identityCommitmentOf(identitySk)).catch(
      (error: unknown) => {
        logger.warn('no identity contract to write a nickname to', {origin: ORIGIN, error: String(error)})
        return undefined
      },
    )
    if (contractAddress === undefined) {
      setSaving(false)
      showToast({message: t('you.nickname.unavailable'), variant: 'error'})
      return
    }
    const written = await writePrimaryName({
      display: checked.display,
      inputs: {
        identitySk,
        contractAddress,
        networkId: network,
        expiresAtSecs: Math.floor(Date.now() / 1000) + TTL_SECS,
      },
    })
    setSaving(false)
    if (!written.ok) {
      showToast({message: t('you.nickname.failed'), variant: 'error'})
      return
    }
    // ⚠️ Cleared on success: a name typed here supersedes whatever onboarding recorded, and leaving
    // the old intent would let a later flush overwrite this one.
    await clearPendingNickname()
    await refresh()
    logger.info('the nickname was changed', {origin: ORIGIN, nickname: checked.display})
    showToast({message: t('you.nickname.saved')})
    router.back()
  }, [checked, saving, session?.forumRoot, session?.network, showToast, t, refresh])

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      style={styles.safeArea}
      contentContainerStyle={styles.scrollContent}
      stickyFooter={
        <StickyFooter>
          <Button
            label={t('you.nickname.save')}
            onPress={() => void save()}
            isLoading={saving}
            isDisabled={checked === undefined || !checked.ok || unchanged || saving}
            size="xl"
            fullWidth
            testID="id-nickname-save"
          />
        </StickyFooter>
      }
    >
      <Typography variant="bodyMd_regular" style={styles.subtitle}>
        {t('you.nickname.about')}
      </Typography>
      <TextInput
        value={typed}
        onChange={setTyped}
        fullWidth
        autoFocus
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="off"
        placeholder={t('onboarding.chooseName.placeholder')}
        isError={rejection !== undefined}
        message={rejection !== undefined ? t(REJECTION_KEY[rejection]) : t('onboarding.chooseName.hint')}
        testID="id-nickname-input"
      />
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {flex: 1},
  scrollContent: {
    paddingHorizontal: theme.spacing.spacing20,
    paddingTop: theme.spacing.spacing24,
    gap: theme.spacing.spacing16,
  },
  subtitle: {textAlign: 'center', color: theme.colors.textAlternative},
}))
