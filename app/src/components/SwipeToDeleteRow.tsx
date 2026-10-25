/**
 * Row wrapper that reveals a destructive delete affordance on a left swipe.
 *
 * Drag the row left to expose a red delete zone, tap it to confirm. Springs
 * open past the halfway point, otherwise snaps back closed. The sliding row
 * sits on an opaque background so the delete zone stays hidden until swiped —
 * pass `sliderColor` to match the surface the row sits on (defaults to the
 * screen background; pass the card colour when the row lives inside a card).
 *
 * Shared by the notifications inbox and the Midnight claim list — keep the
 * interaction in one place rather than copying the gesture maths per screen.
 *
 * @module
 */

import type {ReactNode} from 'react'
import {Pressable, View} from 'react-native'
import {Gesture, GestureDetector} from 'react-native-gesture-handler'
import Animated, {runOnJS, useAnimatedStyle, useSharedValue, withSpring} from 'react-native-reanimated'
import {StyleSheet} from 'react-native-unistyles'
import {ChamferBackground} from './Chamfer'
import {UniIcon} from './UniIcon'

const DELETE_WIDTH = 60
const SNAP_THRESHOLD = DELETE_WIDTH / 2

type SwipeToDeleteRowProps = {
  readonly children: ReactNode
  readonly onDelete: () => void
  readonly deleteTestID?: string
  readonly deleteA11yLabel?: string
  /** Opaque colour for the sliding row, so the delete zone is hidden when closed. */
  readonly sliderColor?: string
}

export const SwipeToDeleteRow = ({
  children,
  onDelete,
  deleteTestID,
  deleteA11yLabel,
  sliderColor,
}: SwipeToDeleteRowProps) => {
  const translateX = useSharedValue(0)
  const startX = useSharedValue(0)

  const snapOpen = () => {
    translateX.value = withSpring(-DELETE_WIDTH, {damping: 20, stiffness: 300})
  }
  const snapClosed = () => {
    translateX.value = withSpring(0, {damping: 20, stiffness: 300})
  }

  const panGesture = Gesture.Pan()
    .activeOffsetX([-8, 8])
    .failOffsetY([-12, 12])
    .onStart(() => {
      startX.value = translateX.value
    })
    .onChange((e) => {
      translateX.value = Math.max(-DELETE_WIDTH, Math.min(0, startX.value + e.translationX))
    })
    .onEnd(() => {
      if (translateX.value <= -SNAP_THRESHOLD) {
        runOnJS(snapOpen)()
      } else {
        runOnJS(snapClosed)()
      }
    })

  const rowAnimStyle = useAnimatedStyle(() => ({
    transform: [{translateX: translateX.value}],
  }))

  return (
    <View style={styles.container}>
      <View style={styles.deleteZone}>
        <ChamferBackground size="auto" cut="topRight" fillToken="errorDefault" />
        <Pressable
          style={styles.deleteButton}
          onPress={() => {
            snapClosed()
            onDelete()
          }}
          testID={deleteTestID}
          accessibilityRole="button"
          accessibilityLabel={deleteA11yLabel}
        >
          <UniIcon name="deleteFilled" size="sm" uniProps={(t) => ({color: t.colors.primaryInverse})} />
        </Pressable>
      </View>

      <GestureDetector gesture={panGesture}>
        <Animated.View
          style={[rowAnimStyle, sliderColor != null ? {backgroundColor: sliderColor} : styles.sliderDefaultBg]}
        >
          {children}
        </Animated.View>
      </GestureDetector>
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    position: 'relative' as const,
    overflow: 'hidden' as const,
  },
  sliderDefaultBg: {
    backgroundColor: theme.colors.backgroundDefault,
  },
  deleteZone: {
    position: 'absolute' as const,
    right: 0,
    top: 0,
    bottom: 0,
    width: DELETE_WIDTH,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  deleteButton: {
    flex: 1,
    width: '100%' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
}))
