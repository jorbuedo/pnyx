/**
 * Community rail — the Discord-style vertical strip on the left of the home
 * layout. Top slot is **direct messages** (Discord's DM-bubble position),
 * followed by the communities you are in, then discover, then create.
 *
 * ⚠️ **Only joined communities, plus whichever one is selected.** The rail used to carry every
 * community on the instance, dimming the ones you were not in — so it grew with the instance rather
 * than with the user, and the strip that answers "where am I" filled with places you had never been.
 * Discovery moved behind its own button. The selected community is kept whatever its membership,
 * because a deep link or a pick from discover lands on one you have not joined, and a rail with no
 * current item reads as though nothing is open.
 *
 * The slot used to open the in-app browser; that moved to Menu, so DMs take the
 * position outright rather than pushing the browser lower
 * (`docs/DIRECT_MESSAGES_PLAN.md`, decided 2026-07-22).
 *
 * @module
 */

import {Pressable, ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {ChamferBackground} from '../../components/Chamfer'
import {Typography} from '../../components/Typography'
import {UniIcon} from '../../components/UniIcon'
import {useI18n} from '../../providers'
import type {Circle} from '../../services/pnyx-api'
import {circleGlyph} from './circle-glyph'

export type CommunityRailProps = {
  /** Communities the viewer is in, rendered below the DM slot. */
  readonly joined: readonly Circle[]
  /**
   * The selected community when it is not one of `joined` — a deep link, or a pick from discover.
   * Rendered dimmed at the end of the list so the rail still shows where you are.
   */
  readonly selectedUnjoined?: Circle | undefined
  /** A circle id, or undefined when the DM slot is what is selected. */
  readonly selectedId: string | undefined
  readonly onSelect: (id: string) => void
  /** True when the DM slot is the current selection, so it renders as active. */
  readonly dmSelected: boolean
  readonly onPressDirectMessages: () => void
  /** True when discover is the current selection, so it renders as active beside the DM slot. */
  readonly discoverSelected: boolean
  readonly onPressDiscover: () => void
  /** Hidden while signed out — the sign-in card gates writes. */
  readonly canCreate: boolean
  readonly onPressCreate: () => void
  /** True when the about pane is the current selection. */
  readonly infoSelected: boolean
  readonly onPressInfo: () => void
}

function RailItem({
  circle,
  isSelected,
  isDimmed,
  onSelect,
}: {
  readonly circle: Circle
  readonly isSelected: boolean
  readonly isDimmed: boolean
  readonly onSelect: (id: string) => void
}) {
  styles.useVariants({selected: isSelected, dimmed: isDimmed})
  return (
    <View style={styles.itemSlot}>
      {isSelected && <View style={styles.selectionPill} testID={`rail-community-${circle.id}-selected`} />}
      <Pressable
        onPress={() => onSelect(circle.id)}
        accessibilityRole="button"
        accessibilityLabel={circle.name}
        accessibilityState={isSelected ? {selected: true} : {}}
        style={styles.itemDisc}
        testID={`rail-community-${circle.id}`}
      >
        {isSelected && <ChamferBackground size="auto" fillToken="primaryMuted" />}
        <Typography variant="headingMd" style={styles.itemInitial}>
          {circleGlyph(circle)}
        </Typography>
      </Pressable>
    </View>
  )
}

export function CommunityRail({
  joined,
  selectedUnjoined,
  selectedId,
  onSelect,
  dmSelected,
  onPressDirectMessages,
  discoverSelected,
  onPressDiscover,
  canCreate,
  onPressCreate,
  infoSelected,
  onPressInfo,
}: CommunityRailProps) {
  const {t} = useI18n()
  return (
    <View style={styles.rail}>
      <ScrollView contentContainerStyle={styles.scrollContent} showsVerticalScrollIndicator={false}>
        <View style={styles.itemSlot}>
          {dmSelected && <View style={styles.selectionPill} testID="rail-direct-messages-selected" />}
          <Pressable
            onPress={onPressDirectMessages}
            accessibilityRole="button"
            accessibilityState={{selected: dmSelected}}
            accessibilityLabel={t('forum.rail.directMessages')}
            style={({pressed}) => [
              styles.actionDisc,
              dmSelected && styles.actionDiscSelected,
              pressed && styles.actionDiscPressed,
            ]}
            testID="rail-direct-messages"
          >
            {dmSelected && <ChamferBackground size="auto" fillToken="backgroundAlternativeHover" />}
            <UniIcon
              name={dmSelected ? 'chatFilled' : 'chat'}
              size="md"
              uniProps={(theme) => ({color: theme.colors.primaryDefault})}
            />
          </Pressable>
        </View>
        <View style={styles.divider} />
        {joined.map((circle) => (
          <RailItem
            key={circle.id}
            circle={circle}
            isSelected={circle.id === selectedId}
            isDimmed={false}
            onSelect={onSelect}
          />
        ))}
        {selectedUnjoined !== undefined && (
          <RailItem
            key={selectedUnjoined.id}
            circle={selectedUnjoined}
            isSelected={selectedUnjoined.id === selectedId}
            isDimmed={true}
            onSelect={onSelect}
          />
        )}
        <View style={styles.itemSlot}>
          {discoverSelected && <View style={styles.selectionPill} testID="rail-discover-selected" />}
          <Pressable
            onPress={onPressDiscover}
            accessibilityRole="button"
            accessibilityState={{selected: discoverSelected}}
            accessibilityLabel={t('forum.rail.discover')}
            style={({pressed}) => [styles.actionDisc, pressed && styles.actionDiscPressed]}
            testID="rail-discover"
          >
            {discoverSelected && <ChamferBackground size="auto" fillToken="backgroundAlternativeHover" />}
            <UniIcon name="search" size="md" uniProps={(theme) => ({color: theme.colors.textDefault})} />
          </Pressable>
        </View>
        {canCreate && (
          <View style={styles.itemSlot}>
            <Pressable
              onPress={onPressCreate}
              accessibilityRole="button"
              accessibilityLabel={t('forum.home.create')}
              style={({pressed}) => [styles.actionDisc, pressed && styles.actionDiscPressed]}
              testID="rail-create"
            >
              <UniIcon name="plus" size="md" uniProps={(theme) => ({color: theme.colors.successDefault})} />
            </Pressable>
          </View>
        )}
        {/* Last, and shown signed out as well: the preprod warning inside it is most worth reading
            before someone has committed anything to a community. */}
        <View style={styles.itemSlot}>
          {infoSelected && <View style={styles.selectionPill} testID="rail-info-selected" />}
          <Pressable
            onPress={onPressInfo}
            accessibilityRole="button"
            accessibilityState={{selected: infoSelected}}
            accessibilityLabel={t('forum.rail.info')}
            style={({pressed}) => [styles.actionDisc, pressed && styles.actionDiscPressed]}
            testID="rail-info"
          >
            {infoSelected && <ChamferBackground size="auto" fillToken="backgroundAlternativeHover" />}
            <UniIcon
              name={infoSelected ? 'infoFilled' : 'info'}
              size="md"
              uniProps={(theme) => ({color: theme.colors.textMuted})}
            />
          </Pressable>
        </View>
      </ScrollView>
    </View>
  )
}

const RAIL_WIDTH = 72
const DISC_SIZE = 48

const styles = StyleSheet.create((theme) => ({
  rail: {
    width: RAIL_WIDTH,
    backgroundColor: theme.colors.backgroundDefault,
  },
  scrollContent: {
    alignItems: 'center',
    paddingVertical: theme.spacing.spacing8,
    gap: theme.spacing.spacing8,
  },
  itemSlot: {
    width: RAIL_WIDTH,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectionPill: {
    position: 'absolute',
    left: 0,
    width: 4,
    height: 36,
    borderTopRightRadius: theme.borderRadius.rounded4,
    borderBottomRightRadius: theme.borderRadius.rounded4,
    backgroundColor: theme.colors.textDefault,
  },
  itemDisc: {
    width: DISC_SIZE,
    height: DISC_SIZE,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.backgroundAlternative,
    variants: {
      selected: {
        // A selected disc drops its circle for the cut; the paint layer supplies
        // the fill, so the box keeps only the shape it is not painting.
        true: {
          backgroundColor: 'transparent',
        },
        false: {
          borderRadius: theme.borderRadius.roundedCircle,
        },
      },
      dimmed: {
        true: {
          opacity: 0.45,
        },
        false: {},
      },
    },
  },
  itemInitial: {
    color: theme.colors.textDefault,
    variants: {
      // Variant axes must be declared on every style that calls useVariants
      // with them — selection is carried by the pill and the chamfer fill,
      // dimming by the disc's opacity.
      selected: {
        true: {},
        false: {},
      },
      dimmed: {
        true: {},
        false: {},
      },
    },
  },
  divider: {
    width: 32,
    height: 2,
    borderRadius: theme.borderRadius.rounded4,
    backgroundColor: theme.colors.borderDefaultWeak,
  },
  actionDisc: {
    width: DISC_SIZE,
    height: DISC_SIZE,
    borderRadius: theme.borderRadius.roundedCircle,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.colors.backgroundAlternative,
  },
  actionDiscPressed: {
    // The disc is a circle when idle and a chamfer when selected, so a painted
    // press surface would be the wrong shape half the time.
    opacity: 0.6,
  },
  // Squared corners when active, matching how a selected community disc reads.
  actionDiscSelected: {},
}))
