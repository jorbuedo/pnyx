/**
 * "Lock now" — hold to arm the gate and drop the session.
 *
 * A hold rather than a tap, unlike the wallet-header button this replaces: the
 * affordance now sits in the tab header, on screen on every tab, where a stray
 * tap would cost an unlock anywhere in the app rather than only on the wallet
 * list. The hold is the deliberate gesture the duress scenario already implies.
 *
 * Hidden unless a PIN is configured — including inside the decoy, where it must
 * look identical.
 *
 * @module
 */

import {ImpactFeedbackStyle, impactAsync, NotificationFeedbackType, notificationAsync} from 'expo-haptics'
import {useCallback, useEffect, useState} from 'react'
import {type AccessibilityActionEvent, Pressable} from 'react-native'
import Animated, {useAnimatedStyle, useSharedValue, withSpring} from 'react-native-reanimated'
import {StyleSheet} from 'react-native-unistyles'
import {useManualLock} from '../hooks/useManualLock'
import {useToast} from '../hooks/useToast'
import {useI18n} from '../providers'
import {type LockHoldPhase, lockButtonVisual} from './lock-button-visual'
import {UniIcon} from './UniIcon'

const SPRING = {damping: 15, stiffness: 300} as const

/**
 * `lockNow` resolves its storage write in a microtask and the gate unmounts
 * this header as soon as it does, so without a beat here the shut padlock never
 * reaches the screen. Deliberately not cleared on unmount: once the hold has
 * committed, the lock must not be cancellable.
 */
const COMMIT_PAINT_MS = 140

export function LockButton() {
  const {t} = useI18n()
  const {showToast} = useToast()
  const {canLock, lockNow} = useManualLock()
  const [phase, setPhase] = useState<LockHoldPhase>('idle')
  const scale = useSharedValue(1)

  const visual = lockButtonVisual(phase)
  const animatedStyle = useAnimatedStyle(() => ({transform: [{scale: scale.value}]}))

  useEffect(() => {
    scale.value = withSpring(visual.scale, SPRING)
  }, [visual.scale, scale])

  const commit = useCallback(() => {
    setPhase('committed')
    notificationAsync(NotificationFeedbackType.Success)
    setTimeout(() => void lockNow(), COMMIT_PAINT_MS)
  }, [lockNow])

  const handleAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === 'longpress') commit()
    },
    [commit],
  )

  if (!canLock) return null

  return (
    <Pressable
      // A tap deliberately does not lock. Saying so is better than a control
      // that visibly reacts and then does nothing.
      onPress={() => showToast({variant: 'neutral', message: t('common.nav.lockNowHint')})}
      onLongPress={commit}
      onPressIn={() => {
        setPhase('holding')
        impactAsync(ImpactFeedbackStyle.Light)
      }}
      onPressOut={() => setPhase((current) => (current === 'committed' ? current : 'idle'))}
      hitSlop={6}
      style={styles.box}
      accessibilityRole="button"
      accessibilityLabel={t('common.nav.lockNow')}
      accessibilityHint={t('common.nav.lockNowHint')}
      accessibilityActions={[{name: 'longpress', label: t('common.nav.lockNow')}]}
      onAccessibilityAction={handleAccessibilityAction}
      testID="top-bar-lock-now"
    >
      <Animated.View style={[animatedStyle, {opacity: visual.opacity}]}>
        <UniIcon name={visual.icon} width={24} height={24} uniProps={(theme) => ({color: theme.colors.iconDefault})} />
      </Animated.View>
    </Pressable>
  )
}

const styles = StyleSheet.create(() => ({
  // Matches the neighbouring naked `ButtonIcon size="md"` box so the three
  // header actions share one baseline.
  box: {
    width: 28,
    height: 28,
    alignItems: 'center',
    justifyContent: 'center',
  },
}))
