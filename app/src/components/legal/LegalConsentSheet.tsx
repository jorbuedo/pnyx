/**
 * Shared legal-consent UI used by both the legacy-migration `WelcomeModal`
 * (its final ToS step) and the lightweight `TosUpdateModal` (a re-accept
 * prompt shown when the pinned ToS/Privacy version changes).
 *
 * Content-only — the caller owns the `ScrollableModal` wrapper so the same
 * sheet can live inside the welcome carousel or stand alone. Manages the
 * inline Terms/Privacy document view internally (tapping a link swaps the
 * body to `LegalDocView` rather than navigating, which avoids the iOS
 * modal-presentation conflict documented below).
 *
 * @module
 */

import type {ReactNode} from 'react'
import {useEffect, useState} from 'react'
import {Image, type ImageSourcePropType, Platform, Pressable, ScrollView as RNScrollView, View} from 'react-native'
import {GestureHandlerRootView, ScrollView} from 'react-native-gesture-handler'
import {StyleSheet} from 'react-native-unistyles'
import {loadPrivacyPolicy} from '../../legal/privacy-policy'
import {loadTOS} from '../../legal/terms-of-service'
import {useI18n} from '../../providers'
import {Markdown} from '../../utils/markdown'
import {Button} from '../Buttons'
import {ChamferBackground} from '../Chamfer'
import {CircleLoader} from '../Loaders'
import {Typography} from '../Typography'
import {UniIcon} from '../UniIcon'

type LegalView = 'terms' | 'privacy' | null

const ScrollViewComponent = Platform.OS === 'web' ? RNScrollView : ScrollView

export type LegalConsentSheetProps = {
  /** Optional hero image above the title; omitted for a text-only sheet. */
  readonly illustration?: ImageSourcePropType
  readonly title: string
  readonly subtitle: string
  readonly ctaLabel: string
  /** Callout copy with `{terms}` / `{privacy}` placeholders for the links. */
  readonly calloutText: string
  readonly termsLabel: string
  readonly privacyLabel: string
  readonly onAgree: () => void | Promise<void>
  /** Optional chrome above the illustration (e.g. carousel logo header). */
  readonly headerSlot?: ReactNode
  /** Optional chrome below the callout (e.g. carousel pagination dots). */
  readonly footerSlot?: ReactNode
  readonly ctaTestID?: string
}

export function LegalConsentSheet({
  illustration,
  title,
  subtitle,
  ctaLabel,
  calloutText,
  termsLabel,
  privacyLabel,
  onAgree,
  headerSlot,
  footerSlot,
  ctaTestID,
}: LegalConsentSheetProps) {
  const [legalView, setLegalView] = useState<LegalView>(null)

  if (legalView) {
    return <LegalDocView kind={legalView} onBack={() => setLegalView(null)} />
  }

  return (
    <View style={styles.content}>
      {headerSlot}
      {illustration ? (
        <View style={styles.illusWrap}>
          <Image
            source={illustration}
            style={styles.illustration}
            resizeMode="contain"
            accessibilityIgnoresInvertColors
          />
        </View>
      ) : null}
      <Typography variant="headingMd" style={styles.title}>
        {title}
      </Typography>
      <View style={styles.subBlock}>
        <Typography variant="bodyMd_regular" style={styles.sub}>
          {subtitle}
        </Typography>
      </View>
      <View style={styles.callout}>
        <ChamferBackground size="auto" fillToken="backgroundDefault" borderToken="borderDefaultWeak" borderWidth={1} />
        <LegalLinksCallout
          calloutText={calloutText}
          termsLabel={termsLabel}
          privacyLabel={privacyLabel}
          onShowLegal={setLegalView}
        />
      </View>
      {footerSlot}
      <Button label={ctaLabel} variant="primary" size="xl" fullWidth onPress={onAgree} testID={ctaTestID} />
    </View>
  )
}

/**
 * Callout with embedded tappable Terms / Privacy links. The copy is one
 * string with `{terms}` and `{privacy}` placeholders so translators control
 * word order; we split at render and slot the links in. Tapping a link asks
 * the parent to swap the body to {@link LegalDocView} (no navigation).
 */
type LegalLinksCalloutProps = {
  readonly calloutText: string
  readonly termsLabel: string
  readonly privacyLabel: string
  readonly onShowLegal: (kind: 'terms' | 'privacy') => void
}

export function LegalLinksCallout({calloutText, termsLabel, privacyLabel, onShowLegal}: LegalLinksCalloutProps) {
  const parts = calloutText.split(/(\{terms\}|\{privacy\})/)
  return (
    <Typography variant="bodySm_regular" style={styles.calloutText}>
      {parts.map((part, i) => {
        if (part === '{terms}') {
          return (
            <Typography
              // biome-ignore lint/suspicious/noArrayIndexKey: stable parts
              key={`t-${i}`}
              variant="bodySm_medium"
              style={styles.link}
              onPress={() => onShowLegal('terms')}
            >
              {termsLabel}
            </Typography>
          )
        }
        if (part === '{privacy}') {
          return (
            <Typography
              // biome-ignore lint/suspicious/noArrayIndexKey: stable parts
              key={`p-${i}`}
              variant="bodySm_medium"
              style={styles.link}
              onPress={() => onShowLegal('privacy')}
            >
              {privacyLabel}
            </Typography>
          )
        }
        return (
          <Typography
            // biome-ignore lint/suspicious/noArrayIndexKey: stable parts
            key={`s-${i}`}
            variant="bodySm_regular"
          >
            {part}
          </Typography>
        )
      })}
    </Typography>
  )
}

/**
 * Inline legal document viewer. Mirrors the `/(legal)/*` screens but stays
 * inside the host RNModal so we don't trigger the iOS modal-presentation
 * conflict (a `presentation: 'modal'` route visually dismisses the RNModal
 * while leaving it `visible` in React, trapping taps on return).
 *
 * `GestureHandlerRootView` is required again inside RNModal (a separate
 * UIWindow on iOS) so the gesture-handler ScrollView's pan wins against
 * Modal's wrapping Pressable. Web uses the native ScrollView.
 */
type LegalDocViewProps = {
  readonly kind: 'terms' | 'privacy'
  readonly onBack: () => void
}

export function LegalDocView({kind, onBack}: LegalDocViewProps) {
  const {t} = useI18n()
  const [content, setContent] = useState<string>('')
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    const load = async () => {
      setIsLoading(true)
      const text = kind === 'terms' ? await loadTOS() : await loadPrivacyPolicy()
      if (cancelled) return
      setContent(text)
      setIsLoading(false)
    }
    load()
    return () => {
      cancelled = true
    }
  }, [kind])

  const title = kind === 'terms' ? t('welcome.step4.termsLink') : t('welcome.step4.privacyLink')

  return (
    <GestureHandlerRootView style={styles.legalRoot}>
      <View style={styles.legalHeader}>
        <Pressable onPress={onBack} hitSlop={12} accessibilityRole="button" testID="welcome-legal-back">
          <UniIcon name="chevronLeft" size="md" uniProps={(tk) => ({color: tk.colors.textDefault})} />
        </Pressable>
        <Typography variant="headingSm" style={styles.legalTitle}>
          {title}
        </Typography>
        <View style={styles.legalHeaderSpacer} />
      </View>
      {isLoading ? (
        <View style={styles.legalLoading}>
          <CircleLoader size="lg" />
        </View>
      ) : (
        <ScrollViewComponent style={styles.legalScroll} contentContainerStyle={styles.legalScrollContent}>
          <Markdown>{content}</Markdown>
        </ScrollViewComponent>
      )}
    </GestureHandlerRootView>
  )
}

const styles = StyleSheet.create((theme, rt) => ({
  content: {
    gap: theme.spacing.spacing16,
  },
  illusWrap: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: theme.spacing.spacing8,
  },
  illustration: {
    width: Math.min(220, rt.screen.height * 0.3),
    height: Math.min(220, rt.screen.height * 0.3),
  },
  title: {
    textAlign: 'center',
    color: theme.colors.textDefault,
  },
  subBlock: {
    alignItems: 'center',
    gap: theme.spacing.spacing4,
  },
  sub: {
    textAlign: 'center',
    color: theme.colors.textAlternative,
  },
  callout: {
    paddingHorizontal: theme.spacing.spacing16,
    paddingVertical: theme.spacing.spacing12,
  },
  calloutText: {
    textAlign: 'center',
    fontStyle: 'italic',
    color: theme.colors.textAlternative,
  },
  link: {
    color: theme.colors.primaryDefault,
  },
  legalRoot: {
    gap: theme.spacing.spacing12,
  },
  legalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingBottom: theme.spacing.spacing12,
    borderBottomWidth: 1,
    borderBottomColor: theme.colors.borderDefaultWeak,
    gap: theme.spacing.spacing8,
  },
  legalTitle: {
    flex: 1,
    textAlign: 'center',
    color: theme.colors.textDefault,
  },
  legalHeaderSpacer: {
    width: 24,
  },
  legalLoading: {
    height: 480,
    alignItems: 'center',
    justifyContent: 'center',
  },
  legalScroll: {
    maxHeight: 480,
  },
  legalScrollContent: {
    paddingBottom: theme.spacing.spacing24,
  },
}))
