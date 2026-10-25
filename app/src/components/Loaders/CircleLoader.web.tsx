/**
 * CircleLoader — web implementation.
 *
 * Uses CSS @keyframes animation instead of Animated.loop because
 * useNativeDriver is unsupported on web, and JS-based animation
 * freezes when the JS thread is busy with re-renders.
 * CSS animations run on the compositor thread, immune to JS blocking.
 *
 * @module
 */

import {memo} from 'react'
import {Path, Svg} from 'react-native-svg'
import {useUnistyles} from 'react-native-unistyles'
import {type CircleLoaderProps, type CircleLoaderSize, SPINNER_PATH, sizeMap} from './CircleLoader.shared'

export type {CircleLoaderSize, CircleLoaderProps}

// Inject the keyframes rule once per document, not per component instance.
let injected = false
function ensureKeyframes() {
  if (injected || typeof document === 'undefined') return
  const style = document.createElement('style')
  style.textContent = '@keyframes circle-loader-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}'
  document.head.appendChild(style)
  injected = true
}

export const CircleLoader = memo(({size = 'md', color, testID}: CircleLoaderProps) => {
  ensureKeyframes()
  const {theme} = useUnistyles()
  const dimensions = sizeMap[size]

  return (
    <div
      data-testid={testID}
      style={{
        width: dimensions.width,
        height: dimensions.height,
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        lineHeight: 0,
        animation: 'circle-loader-spin 1s linear infinite',
      }}
    >
      <Svg width={dimensions.width} height={dimensions.height} viewBox="0 0 20 20" fill="none">
        <Path d={SPINNER_PATH} fill={color ?? theme.colors.primaryDefault} />
      </Svg>
    </div>
  )
})
