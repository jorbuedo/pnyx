/**
 * Onboarding step: pick the identity you want to be.
 *
 * This replaced the "identity name" field. Every tile is a **complete, independently generated
 * identity** — its own entropy, its own 24-word phrase, its own `C` — and the avatar is derived from
 * `C`, so what you pick here is literally which keys you get. Picking among them weakens nothing:
 * the seeds are independently random, and the choice tells an attacker nothing.
 *
 * Why a grid is affordable at all: BIP-39's PBKDF2 runs through OpenSSL on device (~1 ms), not the
 * ~1.1 s pure-JS path it used to (`packages/wallet/account/pbkdf2.native.ts`). A page costs
 * milliseconds, so pagination needs no pre-compute and no spinner.
 *
 * The footer action is the flow's "Continue with biometrics": the enclave key ceremony fires in
 * `preparing`, so a separate explainer step between the two would say the same thing twice.
 *
 * **Unchosen candidates are live wallets.** Their entropy is zeroed when the user commits, and on
 * unmount if they back out — see `discardCandidates`, which is also honest about what it cannot
 * clear (the transient mnemonic strings).
 *
 * @module
 */

import {router} from 'expo-router'
import {useCallback, useEffect, useRef, useState} from 'react'
import {ActivityIndicator, Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../src/components/Buttons'
import {ChamferBackground} from '../../src/components/Chamfer'
import {IdentityAvatar} from '../../src/components/IdentityAvatar'
import {SafeAreaViewWrapper} from '../../src/components/SafeAreaViewWrapper'
import {StickyFooter} from '../../src/components/StickyFooter'
import {Typography} from '../../src/components/Typography'
import {logger} from '../../src/logger'
import {useI18n, useOnboarding} from '../../src/providers'
import {
  discardCandidates,
  generateIdentityCandidates,
  type IdentityCandidate,
  mnemonicForCandidate,
} from '../../src/services/identity-candidates'

/** 3 columns × 4 rows. At ~1 ms of PBKDF2 per candidate a page is imperceptible. */
const PAGE_SIZE = 12

export default function ChooseAvatarRoute() {
  const {t} = useI18n()
  const {setMnemonic} = useOnboarding()

  const [pages, setPages] = useState<readonly (readonly IdentityCandidate[])[]>([])
  const [pageIndex, setPageIndex] = useState(0)
  const [selected, setSelected] = useState<IdentityCandidate | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  // Distinct from `busy`, which belongs to generating a page of candidates — sharing it would put
  // the pager's "next" button into a loading state that has nothing to do with it.
  const [continuing, setContinuing] = useState(false)

  // Committed picks must survive unmount; anything else is wiped on the way out.
  const committedRef = useRef(false)
  const startedRef = useRef(false)
  const pagesRef = useRef<readonly (readonly IdentityCandidate[])[]>([])
  pagesRef.current = pages

  const addPage = useCallback(async () => {
    setBusy(true)
    try {
      const page = await generateIdentityCandidates(PAGE_SIZE)
      setPages((previous) => {
        setPageIndex(previous.length)
        return [...previous, page]
      })
    } catch (error) {
      logger.error('avatar candidates failed', {origin: 'ChooseAvatar', error: String(error)})
    } finally {
      setBusy(false)
    }
  }, [])

  // Guarded by a ref rather than by page count: under fast refresh the effect re-fires whenever
  // `addPage`'s identity changes, and generating a page again is generating more live wallets.
  useEffect(() => {
    if (startedRef.current) return
    startedRef.current = true
    void addPage()
  }, [addPage])

  // Back out (or hardware back) and every generated identity goes with us.
  useEffect(
    () => () => {
      if (committedRef.current) return
      for (const page of pagesRef.current) discardCandidates(page)
    },
    [],
  )

  const onContinue = useCallback(() => {
    if (selected === undefined || continuing) return
    // Set before the work, so the press registers on the frame it happened rather than whenever
    // the device-lock probe and the next screen's mount get around to it. The guard above is the
    // other half: `isLoading` does not stop a Pressable, so a second tap would push twice.
    setContinuing(true)
    committedRef.current = true
    setMnemonic(mnemonicForCandidate(selected))
    // Everything the user did not choose is zeroed before we leave the screen.
    for (const page of pagesRef.current) {
      discardCandidates(page.filter((candidate) => candidate !== selected))
    }
    // On to naming the identity that was just chosen. ⚠️ The biometrics action moved with it: the
    // name step now carries "Continue with biometrics" and runs the device-lock branch, so this
    // button is a plain push and no longer the enclave trigger.
    // Cleared on settle rather than left set: this screen is pushed over, not replaced, so it is
    // still mounted when the user comes back and would otherwise return to a button stuck loading.
    router.push('/onboarding/choose-name')
    setContinuing(false)
  }, [selected, continuing, setMnemonic])

  const page = pages[pageIndex] ?? []
  const canGoBack = pageIndex > 0
  // Unbounded on purpose: a page of candidates is ~400 bytes of entropy, all of it zeroed on the
  // way out and none of it ever persisted, so capping how long someone may browse for a face they
  // like would trade real usability for no real safety.
  const canGoForward = true

  return (
    <SafeAreaViewWrapper
      edges={['bottom']}
      scrollable
      style={styles.safeArea}
      contentContainerStyle={styles.scrollContent}
      stickyFooter={
        <StickyFooter>
          <Button
            label={t('common.buttons.continue')}
            onPress={onContinue}
            isLoading={continuing}
            isDisabled={selected === undefined || continuing}
            size="xl"
            fullWidth
            testID="choose-avatar-continue"
          />
        </StickyFooter>
      }
    >
      <Typography variant="bodyMd_regular" style={styles.subtitle}>
        {t('onboarding.chooseAvatar.subtitle')}
      </Typography>

      <View style={styles.picker}>
        <View style={styles.grid} testID="choose-avatar-grid">
          {page.map((candidate) => {
            const isSelected = candidate === selected
            return (
              <Pressable
                key={candidate.pnyxId}
                onPress={() => setSelected(candidate)}
                accessibilityRole="radio"
                accessibilityState={{selected: isSelected}}
                accessibilityLabel={t('onboarding.chooseAvatar.optionLabel')}
                style={styles.tile}
                testID={`choose-avatar-option-${candidate.pnyxId.slice(-6)}`}
              >
                <ChamferBackground
                  size="auto"
                  fillToken={isSelected ? 'primaryAlternative' : 'backgroundAlternative'}
                  {...(isSelected ? {borderToken: 'primaryDefault' as const, borderWidth: 2} : {})}
                />
                <IdentityAvatar pnyxId={candidate.pnyxId} size={72} />
              </Pressable>
            )
          })}
          {page.length === 0 && <ActivityIndicator />}
        </View>

        <View style={styles.pager}>
          <Button
            label={t('onboarding.chooseAvatar.previous')}
            variant="secondary"
            leftIcon="chevronLeft"
            onPress={() => setPageIndex((previous) => Math.max(0, previous - 1))}
            isDisabled={!canGoBack || busy}
            testID="choose-avatar-previous"
          />
          <Typography variant="bodyXs_regular" style={styles.pagerLabel}>
            {t('onboarding.chooseAvatar.page', {page: pageIndex + 1, total: Math.max(pages.length, 1)})}
          </Typography>
          <Button
            label={t('onboarding.chooseAvatar.next')}
            variant="secondary"
            rightIcon="chevronRight"
            onPress={() => {
              if (pageIndex < pages.length - 1) setPageIndex(pageIndex + 1)
              else void addPage()
            }}
            isDisabled={!canGoForward || busy}
            isLoading={busy}
            testID="choose-avatar-next"
          />
        </View>
      </View>
    </SafeAreaViewWrapper>
  )
}

const styles = StyleSheet.create((theme) => ({
  safeArea: {flex: 1},
  scrollContent: {
    flexGrow: 1,
    paddingHorizontal: theme.spacing.spacing16,
    paddingTop: theme.spacing.spacing24,
    // No `paddingBottom`: SafeAreaViewWrapper measures the sticky footer and applies its height
    // here. Setting one clobbers that, the content box then runs behind the footer, and anything
    // centred inside it sits visibly low.
    gap: theme.spacing.spacing20,
  },
  /**
   * Takes the slack between the description and the footer and centres in it, so there is no dead
   * band above the button while the description stays where it reads first.
   *
   * `flexGrow` with `flexShrink: 0`, not `flex: 1`: growing into spare space is the intent, but
   * *shrinking* would compress the grid on a short screen and push the pager under the footer —
   * which is what happened at 1080×1600. Refusing to shrink makes the content outgrow the viewport
   * instead, and the wrapper scrolls it.
   */
  picker: {
    flexGrow: 1,
    flexShrink: 0,
    justifyContent: 'center',
    gap: theme.spacing.spacing20,
  },
  subtitle: {textAlign: 'center', color: theme.colors.textAlternative},
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'center',
    gap: theme.spacing.spacing12,
  },
  tile: {
    padding: theme.spacing.spacing8,
  },
  pager: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: theme.spacing.spacing8,
  },
  pagerLabel: {color: theme.colors.textMuted},
}))
