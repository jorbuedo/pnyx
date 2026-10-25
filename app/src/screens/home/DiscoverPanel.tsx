/**
 * Discover — communities you are not in yet, in the home layout's right zone.
 *
 * The rail used to carry these below the joined ones, dimmed. That made the rail grow with the
 * *instance* rather than with the user: every community anyone ever created sat in a strip whose
 * whole job is "the places I am". Discovery is something you go looking for, so it became a
 * destination of its own beside DMs.
 *
 * ⚠️ **Invite-only communities are excluded.** An invite is the whole gate (`product/STATUS.md` §5 —
 * the decision was that gating is an invite, not a predicate in `join`), so a gated circle is not a
 * place a stranger can enter and listing one would be a promise this screen cannot keep. You reach a
 * gated circle by holding an invite, never by browsing.
 *
 * Tapping one selects it rather than joining it: the channel panel already owns the join flow with
 * its "appear as" choice, and a second join surface is how the two drift.
 *
 * @module
 */

import {Pressable, RefreshControl, ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {ChamferBackground} from '../../components/Chamfer'
import {EmptyState} from '../../components/EmptyState'
import {ChainBadge} from '../../components/forum/ChainBadge'
import {Typography} from '../../components/Typography'
import {useI18n} from '../../providers'
import type {Circle} from '../../services/pnyx-api'

export type DiscoverPanelProps = {
  /** Communities the viewer is not a member of, in the order the list should read. */
  readonly circles: readonly Circle[]
  /** Whether the community list itself failed to load, so the pane says that rather than "none". */
  readonly listError: boolean
  readonly isLoading: boolean
  readonly onRefresh: () => void
  /** Selects the community; the channel panel takes it from there. */
  readonly onSelect: (id: string) => void
}

export function DiscoverPanel({circles, listError, isLoading, onRefresh, onSelect}: DiscoverPanelProps) {
  const {t} = useI18n()
  return (
    <View style={styles.panel}>
      <View style={styles.header}>
        <Typography variant="headingSm" numberOfLines={1}>
          {t('forum.discover.title')}
        </Typography>
      </View>
      {listError ? (
        <View style={styles.empty}>
          <Typography variant="bodySm_regular" style={styles.error} testID="discover-error">
            {t('forum.discover.unreachable')}
          </Typography>
        </View>
      ) : circles.length === 0 ? (
        <View style={styles.empty}>
          <EmptyState
            icon="community"
            title={t('forum.discover.emptyTitle')}
            description={t('forum.discover.emptyDescription')}
            testID="discover-empty"
          />
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.listContent}
          refreshControl={<RefreshControl refreshing={isLoading} onRefresh={onRefresh} />}
          showsVerticalScrollIndicator={false}
        >
          {circles.map((circle) => (
            <Pressable
              key={circle.id}
              onPress={() => onSelect(circle.id)}
              accessibilityRole="button"
              accessibilityLabel={circle.name}
              style={styles.row}
              testID={`discover-circle-${circle.id}`}
            >
              <ChamferBackground size="auto" fillToken="backgroundAlternative" />
              {/* The character its founder chose, so a community a reader already knows is
                  recognisable before they read its name — and nothing when none was chosen, since
                  the fallback initial only repeats the name printed beside it. */}
              <View style={styles.rowTitle}>
                {circle.displayChar !== undefined && (
                  <Typography variant="bodyMd_medium">{circle.displayChar}</Typography>
                )}
                <Typography variant="bodyMd_medium" numberOfLines={1} style={styles.rowName}>
                  {circle.name}
                </Typography>
              </View>
              {circle.description.length > 0 && (
                <Typography variant="bodyXs_regular" style={styles.rowDescription} numberOfLines={2}>
                  {circle.description}
                </Typography>
              )}
              <View style={styles.rowMeta}>
                <Typography variant="bodyXs_regular" style={styles.meta}>
                  {t('forum.home.members', {count: circle.memberCount})}
                </Typography>
                {!circle.isOpen && (
                  <Typography variant="bodyXs_regular" style={styles.meta} testID="discover-invite-only">
                    {t('forum.discover.inviteOnly')}
                  </Typography>
                )}
                <ChainBadge chain={circle.chain} template={circle.template} />
              </View>
            </Pressable>
          ))}
        </ScrollView>
      )}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  panel: {
    flex: 1,
    overflow: 'hidden',
  },
  header: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingVertical: theme.spacing.spacing12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefaultWeak,
  },
  empty: {
    flex: 1,
    justifyContent: 'center',
    padding: theme.spacing.spacing16,
    gap: theme.spacing.spacing12,
  },
  listContent: {
    padding: theme.spacing.spacing12,
    gap: theme.spacing.spacing8,
  },
  row: {
    gap: theme.spacing.spacing4,
    padding: theme.spacing.spacing12,
  },
  rowDescription: {
    color: theme.colors.textAlternative,
  },
  rowTitle: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
  },
  // Shrinks rather than pushing the glyph off the row: the name is the part that can be long.
  rowName: {
    flexShrink: 1,
  },
  rowMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing8,
  },
  meta: {
    color: theme.colors.textMuted,
  },
  error: {
    color: theme.colors.errorDefault,
    textAlign: 'center',
  },
}))
