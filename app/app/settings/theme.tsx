/**
 * Theme selection screen.
 *
 * Allows users to choose between System, Light, and Dark mode.
 *
 * @module
 */

import {Pressable, useColorScheme, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {ChamferBackground} from '../../src/components/Chamfer'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {SettingsPickerRow} from '../../src/components/SettingsPickerRow'
import {Typography} from '../../src/components/Typography'
import {UniIcon, type UniIconName} from '../../src/components/UniIcon'
import {useI18n, useTheme} from '../../src/providers'
import {type AccentName, accentNames, swatchColorFor} from '../../src/theme/accent-ramps'
import {useIsDark} from '../../src/theme/use-is-dark'

type ThemeOption = 'system' | 'light' | 'dark'

type ThemeOptionItem = {
  value: ThemeOption
  label: string
  sublabel: string
  icon: UniIconName
}

export default function ThemeScreen() {
  const {t} = useI18n()
  const {themeMode, setThemeMode, accent, setAccent} = useTheme()
  const isDark = useIsDark()
  const systemScheme = useColorScheme()

  const resolvedLabel = systemScheme === 'dark' ? t('settings.appearance.dark') : t('settings.appearance.light')

  const options: ThemeOptionItem[] = [
    {
      value: 'system',
      label: t('settings.theme.system'),
      sublabel: t('settings.theme.systemDescriptionDynamic', {resolved: resolvedLabel}),
      icon: 'systemDefaultTheme',
    },
    {
      value: 'light',
      label: t('settings.appearance.light'),
      sublabel: t('settings.theme.lightDescription'),
      icon: 'lightMode',
    },
    {
      value: 'dark',
      label: t('settings.appearance.dark'),
      sublabel: t('settings.theme.darkDescription'),
      icon: 'nightMode',
    },
  ]

  return (
    <SafeAreaViewWrapper
      style={styles.safeArea}
      edges={['bottom']}
      scrollable
      contentContainerStyle={styles.scrollContent}
    >
      <View style={styles.list}>
        {options.map((option) => (
          <SettingsPickerRow
            key={option.value}
            label={option.label}
            sublabel={option.sublabel}
            leftGlyph={
              <UniIcon name={option.icon} size="md" uniProps={(theme) => ({color: theme.colors.iconDefault})} />
            }
            selected={option.value === themeMode}
            onPress={() => setThemeMode(option.value)}
            testID={`theme-option-${option.value}`}
            checkboxVariant="radio"
          />
        ))}
      </View>

      <View style={styles.paletteSection}>
        <Typography variant="bodySm_medium" style={styles.paletteLabel}>
          {t('settings.theme.paletteSection')}
        </Typography>
        <View style={styles.paletteGrid}>
          {accentNames.map((name) => (
            <PaletteSwatch
              key={name}
              accent={name}
              isSelected={name === accent}
              isDark={isDark}
              label={t(`settings.theme.palette.${name}`)}
              onPress={() => setAccent(name)}
            />
          ))}
        </View>
      </View>
    </SafeAreaViewWrapper>
  )
}

/**
 * One scheme, shown as the mark it will paint.
 *
 * ⚠️ The tint is a literal, not a token, and that is correct here: a picker shows the schemes you
 * are *not* using, which no token of the active theme can name. `swatchColorFor` is the one
 * sanctioned read of another scheme's colour.
 */
function PaletteSwatch({
  accent,
  isSelected,
  isDark,
  label,
  onPress,
}: {
  accent: AccentName
  isSelected: boolean
  isDark: boolean
  label: string
  onPress: () => void
}) {
  const tint = swatchColorFor(accent, isDark)
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="radio"
      accessibilityState={{selected: isSelected}}
      accessibilityLabel={label}
      testID={`palette-option-${accent}`}
      style={styles.swatch}
    >
      <ChamferBackground
        size="auto"
        fillToken="backgroundAlternative"
        {...(isSelected
          ? {borderColor: tint, borderWidth: 2}
          : {borderToken: 'borderDefaultWeak' as const, borderWidth: 1})}
      />
      <UniIcon name="pnyxLogo" size="lg" color={tint} />
    </Pressable>
  )
}

const styles = StyleSheet.create(({spacing, colors}) => ({
  safeArea: {
    flex: 1,
  },
  scrollContent: {
    paddingHorizontal: spacing.spacing16,
  },
  list: {
    gap: spacing.spacing6,
  },
  paletteSection: {
    paddingTop: spacing.spacing24,
    gap: spacing.spacing12,
  },
  paletteLabel: {
    color: colors.textAlternative,
  },
  paletteGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: spacing.spacing12,
    // The row spans the full content width: four swatches at 23% leave 8% for the three gaps, and
    // `space-between` pins the outer two to the edges. No measuring, and no gap constant duplicated
    // between the style and the arithmetic.
    //
    // ⚠️ Assumes full rows — true while the scheme count is a multiple of four (twelve today). A
    // partial last row would be spread across the width rather than left-aligned.
    justifyContent: 'space-between',
    // ⚠️ Without this the swatches are not square. A wrapping row defaults to `alignItems: stretch`,
    // which hands every item a definite height from the line — and `aspectRatio` can only derive the
    // dimension that is still free. Measured 229×156 before, 229×229 after.
    alignItems: 'flex-start',
  },
  swatch: {
    width: '23%',
    // Square by ratio rather than a fixed size, so the swatch grows with the window and the height
    // follows the width.
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
}))
