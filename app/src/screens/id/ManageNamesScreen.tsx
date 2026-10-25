/**
 * The names this identity holds, which one is shown, and how a name changes hands.
 *
 * Reached by tapping the name on the ID tab. Claiming lives on its own screen and is linked from the
 * bottom — this one is about names already held.
 *
 * ⚠️ **Setting a name active is a claim on a name you already hold.** `claimHandle` reads the shell's
 * own record, finds it already bound to this identity, and skips to the write that displays it — so
 * there is no second entry point to keep in step with the first.
 *
 * @module
 */

import {useFocusEffect, useRouter} from 'expo-router'
import {useCallback} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../components/Buttons'
import {Card} from '../../components/Card'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {SectionHeader} from '../../components/SectionHeader'
import {Typography} from '../../components/Typography'
import {useHeldNames} from '../../hooks/useHeldNames'
import {useI18n} from '../../providers'
import type {HeldName} from '../../services/held-names'

export function ManageNamesScreen() {
  const {t} = useI18n()
  const router = useRouter()
  const {names, loading, busy, claim, refresh} = useHeldNames()
  // ⚠️ The claim screen has its own copy of every read behind this list, so a name claimed there leaves
  // this one showing its mount-time answer — the new name missing, and the old one still marked shown.
  useFocusEffect(
    useCallback(() => {
      void refresh()
    }, [refresh]),
  )

  return (
    <SafeAreaViewWrapper style={styles.safeArea} edges={[]} scrollable>
      <View style={styles.content}>
        <View style={styles.section}>
          <SectionHeader title={t('you.handle.manage.heldTitle')} />
          <Card style={styles.card} testID="manage-names-held">
            <Typography variant="bodyXs_regular" style={styles.muted}>
              {t('you.handle.manage.heldHint')}
            </Typography>
            {!loading && names.length === 0 && (
              <Typography variant="bodySm_regular" style={styles.muted} testID="manage-names-empty">
                {t('you.handle.manage.empty')}
              </Typography>
            )}
            {names.map((name) => (
              <NameRow key={name.canonical} name={name} busy={busy} onShow={() => void claim(name.display)} />
            ))}
          </Card>
        </View>

        <View style={styles.section}>
          <SectionHeader title={t('you.handle.manage.transferTitle')} />
          <Card style={styles.card} testID="manage-names-transfer">
            <Typography variant="bodyXs_regular" style={styles.muted}>
              {t('you.handle.manage.transferHint')}
            </Typography>
          </Card>
        </View>

        <Button
          label={t('you.handle.manage.claimAnother')}
          variant="secondary"
          onPress={() => router.push('/id/name')}
          fullWidth
          testID="manage-names-claim"
        />
      </View>
    </SafeAreaViewWrapper>
  )
}

/**
 * One held name.
 *
 * ⚠️ Only a name verified as owned offers to be shown. Writing `primaryName` for a name the handle
 * contract does not agree is ours produces a row every reader's bidirectional check rejects — a name
 * that appears set and resolves for nobody.
 */
function NameRow({name, busy, onShow}: {readonly name: HeldName; readonly busy: boolean; readonly onShow: () => void}) {
  const {t} = useI18n()
  return (
    <View style={styles.row} testID={`manage-name-${name.canonical}`}>
      <View style={styles.rowText}>
        <Typography variant="bodySm_medium" numberOfLines={1}>
          {name.display}
        </Typography>
        {name.status !== 'owned' && (
          <Typography variant="bodyXs_regular" style={styles.warn}>
            {t(name.status === 'not-owned' ? 'you.handle.manage.notOwned' : 'you.handle.manage.unverified')}
          </Typography>
        )}
      </View>
      {name.active ? (
        <Typography variant="bodySm_regular" style={styles.active}>
          {t('you.handle.manage.active')}
        </Typography>
      ) : (
        name.status === 'owned' && (
          <Button
            label={t('you.handle.manage.setActive')}
            variant="secondary"
            size="sm"
            onPress={onShow}
            isDisabled={busy}
            isLoading={busy}
            testID={`manage-name-show-${name.canonical}`}
          />
        )
      )}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {flex: 1},
  content: {padding: theme.spacing.spacing16, gap: theme.spacing.spacing16},
  section: {width: '100%'},
  card: {width: '100%', gap: theme.spacing.spacing8, padding: theme.spacing.spacing16},
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing4,
  },
  rowText: {flex: 1, gap: theme.spacing.spacing2},
  muted: {color: theme.colors.textAlternative},
  warn: {color: theme.colors.errorDefault},
  active: {color: theme.colors.successDefault},
}))
