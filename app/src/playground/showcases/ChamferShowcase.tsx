/**
 * Chamfer Showcase.
 *
 * Experiment: asymmetrical bevelled corners (top-right + bottom-left) replacing
 * the rounded corners on buttons, cards, inputs, pills and selectors — shown at
 * four intensities against the current rounded treatment.
 *
 * @module
 */

import {useState} from 'react'
import {Pressable, ScrollView, View} from 'react-native'
import {StyleSheet, useUnistyles} from 'react-native-unistyles'
import {Card} from '../../components/Card'
import type {ChamferCut} from '../../components/Chamfer'
import {ChamferSurface} from '../../components/Chamfer'
import {Typography} from '../../components/Typography'
import {UniIcon} from '../../components/UniIcon'
import {ShowcaseSection} from '../components'

type Level = {
  readonly key: string
  readonly label: string
  readonly note: string
  readonly size: number
  readonly cut: ChamferCut
  readonly brackets: boolean
}

const LEVELS: readonly Level[] = [
  {key: 'subtle', label: 'A · Subtle', note: '6pt cut, diagonal', size: 6, cut: 'diagonal', brackets: false},
  {key: 'medium', label: 'B · Medium', note: '10pt cut, diagonal', size: 10, cut: 'diagonal', brackets: false},
  {key: 'strong', label: 'C · Strong', note: '14pt cut, diagonal', size: 14, cut: 'diagonal', brackets: false},
  {key: 'hud', label: 'D · HUD', note: '12pt cut + corner brackets', size: 12, cut: 'diagonal', brackets: true},
]

/** A chamfered stand-in for the primary Button. */
const ChamferButton = ({
  label,
  level,
  tone = 'primary',
  leftIcon,
}: {
  label: string
  level: Level
  tone?: 'primary' | 'secondary' | 'error'
  leftIcon?: 'send' | 'arrowUpRight' | undefined
}) => {
  const {theme} = useUnistyles()

  const fill =
    tone === 'primary'
      ? ([theme.colors.btnPrimaryGradientStart, theme.colors.btnPrimaryGradientEnd] as const)
      : tone === 'error'
        ? theme.colors.errorDefault
        : theme.colors.backgroundAlternative

  const textColor = tone === 'secondary' ? theme.colors.textDefault : theme.colors.primaryInverse

  return (
    <ChamferSurface
      size={level.size}
      cut={level.cut}
      fill={fill}
      borderColor={tone === 'secondary' ? theme.colors.borderDefaultWeak : undefined}
      borderWidth={tone === 'secondary' ? theme.borderWidth.s : 0}
      brackets={level.brackets ? {colorToken: 'primaryInverse', width: 1.5} : undefined}
      style={styles.button}
    >
      {leftIcon && <UniIcon name={leftIcon} size="sm" color={textColor} />}
      <Typography variant="bodyMd_medium" style={{color: textColor}}>
        {label}
      </Typography>
    </ChamferSurface>
  )
}

/** A chamfered stand-in for Card. */
const ChamferCard = ({level, children}: {level: Level; children: React.ReactNode}) => {
  const {theme} = useUnistyles()

  return (
    <ChamferSurface
      size={level.size}
      cut={level.cut}
      fill={theme.colors.backgroundAlternative}
      borderColor={theme.colors.borderDefaultWeak}
      borderWidth={theme.borderWidth.s}
      brackets={level.brackets ? {colorToken: 'primaryDefault', width: 1.5} : undefined}
      style={styles.card}
    >
      {children}
    </ChamferSurface>
  )
}

/** A chamfered stand-in for the pill/Tag. */
const ChamferTag = ({label, level, active}: {label: string; level: Level; active?: boolean}) => {
  const {theme} = useUnistyles()

  return (
    <ChamferSurface
      size={Math.min(level.size, 8)}
      cut={level.cut}
      fill={active ? theme.colors.primaryDefault : 'transparent'}
      borderColor={active ? undefined : theme.colors.borderDefaultWeak}
      borderWidth={active ? 0 : theme.borderWidth.s}
      style={styles.tag}
    >
      <Typography
        variant="bodySm_medium"
        style={{color: active ? theme.colors.primaryInverse : theme.colors.textAlternative}}
      >
        {label}
      </Typography>
    </ChamferSurface>
  )
}

/** A chamfered stand-in for the text input. */
const ChamferInput = ({level, placeholder}: {level: Level; placeholder: string}) => {
  const {theme} = useUnistyles()

  return (
    <ChamferSurface
      size={level.size}
      cut={level.cut}
      fill={theme.colors.backgroundAlternative}
      borderColor={theme.colors.borderDefaultWeak}
      borderWidth={theme.borderWidth.s}
      style={styles.input}
    >
      <Typography variant="bodyMd_regular" style={{color: theme.colors.textAlternative}}>
        {placeholder}
      </Typography>
    </ChamferSurface>
  )
}

/** A chamfered stand-in for SegmentedControl. */
const ChamferSegmented = ({level}: {level: Level}) => {
  const {theme} = useUnistyles()
  const [selected, setSelected] = useState(0)
  const segments = ['Send', 'Receive', 'Swap']

  return (
    <ChamferSurface
      size={level.size}
      cut={level.cut}
      fill={theme.colors.backgroundDefault}
      borderColor={theme.colors.borderDefaultWeak}
      borderWidth={theme.borderWidth.s}
      style={styles.segmented}
    >
      {segments.map((segment, index) => (
        <Pressable key={segment} onPress={() => setSelected(index)} style={styles.segmentPressable}>
          <ChamferSurface
            size={Math.max(level.size - 3, 3)}
            cut={level.cut}
            fill={selected === index ? theme.colors.primaryDefault : 'transparent'}
            style={styles.segment}
          >
            <Typography
              variant="bodySm_medium"
              style={{color: selected === index ? theme.colors.primaryInverse : theme.colors.textAlternative}}
            >
              {segment}
            </Typography>
          </ChamferSurface>
        </Pressable>
      ))}
    </ChamferSurface>
  )
}

/** One full atom set rendered at a single intensity. */
const LevelBlock = ({level}: {level: Level}) => {
  const {theme} = useUnistyles()

  return (
    <View style={styles.levelBlock}>
      <View style={styles.row}>
        <ChamferButton label="Confirm" level={level} />
        <ChamferButton label="Cancel" level={level} tone="secondary" />
      </View>

      <View style={styles.row}>
        <ChamferButton label="Send" level={level} leftIcon="send" />
        <ChamferButton label="Revoke" level={level} tone="error" />
      </View>

      <ChamferInput level={level} placeholder="Search circles" />

      <View style={styles.row}>
        <ChamferTag label="All" level={level} active />
        <ChamferTag label="Cardano" level={level} />
        <ChamferTag label="Midnight" level={level} />
      </View>

      <ChamferSegmented level={level} />

      <ChamferCard level={level}>
        <View style={styles.cardHeader}>
          <ChamferSurface
            size={Math.min(level.size, 8)}
            cut={level.cut}
            fill={theme.colors.primaryDefault}
            style={styles.avatar}
          >
            <Typography variant="bodySm_medium" style={{color: theme.colors.primaryInverse}}>
              P
            </Typography>
          </ChamferSurface>
          <View style={styles.cardHeaderText}>
            <Typography variant="bodyMd_medium" style={styles.cardTitle}>
              Treasury allocation
            </Typography>
            <Typography variant="bodySm_regular" style={styles.cardSubtitle}>
              Closes in 3 days · 412 votes
            </Typography>
          </View>
        </View>
        <View style={styles.cardFooter}>
          <ChamferTag label="Governance" level={level} />
          <ChamferTag label="Open" level={level} />
        </View>
      </ChamferCard>
    </View>
  )
}

export const ChamferShowcase = () => {
  const {theme} = useUnistyles()

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection
        title="Rounded — today"
        description="The current treatment, for comparison against the four cuts below."
      >
        <View style={styles.roundedRow}>
          <View style={styles.roundedButton}>
            <Typography variant="bodyMd_medium" style={{color: theme.colors.primaryInverse}}>
              Confirm
            </Typography>
          </View>
          <View style={styles.roundedButtonSecondary}>
            <Typography variant="bodyMd_medium" style={{color: theme.colors.textDefault}}>
              Cancel
            </Typography>
          </View>
        </View>
        <View style={styles.roundedCard}>
          <Typography variant="bodyMd_medium" style={styles.cardTitle}>
            Treasury allocation
          </Typography>
          <Typography variant="bodySm_regular" style={styles.cardSubtitle}>
            Closes in 3 days · 412 votes
          </Typography>
        </View>
      </ShowcaseSection>

      {LEVELS.map((level) => (
        <ShowcaseSection key={level.key} title={level.label} description={level.note}>
          <LevelBlock level={level} />
        </ShowcaseSection>
      ))}

      <ShowcaseSection
        title="Bracket highlight"
        description="Card highlighted — an emphasis affordance for one card in a list, not a default."
      >
        <Card variant="filled" style={styles.card}>
          <Typography variant="bodyMd_medium" style={styles.cardTitle}>
            Ordinary card
          </Typography>
          <Typography variant="bodySm_regular" style={styles.cardSubtitle}>
            Closes in 3 days · 412 votes
          </Typography>
        </Card>
        <Card variant="filled" highlighted style={styles.card}>
          <Typography variant="bodyMd_medium" style={styles.cardTitle}>
            Treasury allocation
          </Typography>
          <Typography variant="bodySm_regular" style={styles.cardSubtitle}>
            Closes in 3 days · 412 votes
          </Typography>
        </Card>
        <Card variant="selected" highlighted style={styles.card}>
          <Typography variant="bodyMd_medium" style={styles.cardTitle}>
            Selected and highlighted
          </Typography>
          <Typography variant="bodySm_regular" style={styles.cardSubtitle}>
            Both affordances at once
          </Typography>
        </Card>
      </ShowcaseSection>

      <ShowcaseSection title="Cut direction" description="Which corners get sliced, at a 12pt cut.">
        <View style={styles.directionGrid}>
          {(['diagonal', 'diagonalReverse', 'all', 'top', 'bottom'] as const).map((cut) => (
            <View key={cut} style={styles.directionItem}>
              <ChamferSurface
                size={12}
                cut={cut}
                fill={[theme.colors.btnPrimaryGradientStart, theme.colors.btnPrimaryGradientEnd] as const}
                style={styles.directionSwatch}
              />
              <Typography variant="bodyXs_regular" style={styles.levelNote}>
                {cut}
              </Typography>
            </View>
          ))}
        </View>
      </ShowcaseSection>
    </ScrollView>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
  },
  content: {
    paddingVertical: theme.spacing.spacing16,
    gap: theme.spacing.spacing32,
    paddingBottom: theme.spacing.spacing80,
  },
  levelBlock: {
    gap: theme.spacing.spacing12,
  },
  levelHeader: {
    gap: theme.spacing.spacing2,
  },
  levelTitle: {
    color: theme.colors.textDefault,
  },
  levelNote: {
    color: theme.colors.textAlternative,
  },
  row: {
    flexDirection: 'row',
    gap: theme.spacing.spacing12,
    flexWrap: 'wrap',
  },
  button: {
    minHeight: theme.buttonSizes.m,
    paddingHorizontal: theme.spacing.spacing20,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.spacing8,
  },
  card: {
    padding: theme.spacing.spacing16,
    gap: theme.spacing.spacing12,
  },
  cardHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.spacing12,
  },
  cardHeaderText: {
    flex: 1,
    gap: theme.spacing.spacing2,
  },
  cardTitle: {
    color: theme.colors.textDefault,
  },
  cardSubtitle: {
    color: theme.colors.textAlternative,
  },
  cardFooter: {
    flexDirection: 'row',
    gap: theme.spacing.spacing8,
  },
  avatar: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tag: {
    paddingHorizontal: theme.spacing.spacing12,
    paddingVertical: theme.spacing.spacing6,
    alignItems: 'center',
    justifyContent: 'center',
  },
  input: {
    minHeight: theme.inputSizes.m,
    paddingHorizontal: theme.spacing.spacing16,
    justifyContent: 'center',
  },
  segmented: {
    flexDirection: 'row',
    padding: theme.spacing.spacing4,
    gap: theme.spacing.spacing4,
  },
  segmentPressable: {
    flex: 1,
  },
  segment: {
    paddingVertical: theme.spacing.spacing8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundedRow: {
    flexDirection: 'row',
    gap: theme.spacing.spacing12,
  },
  roundedButton: {
    minHeight: theme.buttonSizes.m,
    paddingHorizontal: theme.spacing.spacing20,
    borderRadius: theme.borderRadius.rounded12,
    backgroundColor: theme.colors.primaryDefault,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundedButtonSecondary: {
    minHeight: theme.buttonSizes.m,
    paddingHorizontal: theme.spacing.spacing20,
    borderRadius: theme.borderRadius.rounded12,
    borderWidth: theme.borderWidth.s,
    borderColor: theme.colors.borderDefaultWeak,
    backgroundColor: theme.colors.backgroundAlternative,
    alignItems: 'center',
    justifyContent: 'center',
  },
  roundedCard: {
    borderRadius: theme.borderRadius.rounded12,
    backgroundColor: theme.colors.backgroundAlternative,
    borderWidth: theme.borderWidth.s,
    borderColor: theme.colors.borderDefaultWeak,
    padding: theme.spacing.spacing16,
    gap: theme.spacing.spacing2,
  },
  directionGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.spacing.spacing12,
  },
  directionItem: {
    alignItems: 'center',
    gap: theme.spacing.spacing4,
  },
  directionSwatch: {
    width: 84,
    height: 56,
  },
}))
