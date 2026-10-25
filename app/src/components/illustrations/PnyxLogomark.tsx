import Svg, {Path} from 'react-native-svg'
import {useUnistyles} from 'react-native-unistyles'

type Props = {
  width?: number
  /** Mark color; defaults to the brand logo color (violet on light, lilac on dark). */
  color?: string
}

/** The Pnyx amphitheater logomark (assets/logo.svg, same geometry). */
export const PnyxLogomark = ({width = 184, color}: Props) => {
  const {theme} = useUnistyles()
  const markColor = color ?? theme.colors.logoPrimary
  const height = width * (175 / 174)
  return (
    <Svg width={width} height={height} viewBox="0 0 174 175" fill="none">
      <Path fill="none" stroke={markColor} strokeWidth={16.045} d="M147.5 36.734a78.978 78.978 0 1 1-121 0" />
      <Path
        fill="none"
        stroke={markColor}
        strokeMiterlimit={10}
        strokeWidth={12}
        d="M16.045 87.5h18a52.955 52.955 0 0 0 105.91 0h-24a28.955 28.955 0 0 1-57.91 0v-6"
      />
      <Path
        fill={markColor}
        d="M53.049 53.549h16.334v16.334H53.049zm25.784 0h16.334v16.334H78.833zm25.784 0h16.334v16.334h-16.334z"
      />
    </Svg>
  )
}
