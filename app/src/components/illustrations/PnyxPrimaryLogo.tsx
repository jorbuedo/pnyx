import {Text, View} from 'react-native'
import {useUnistyles} from 'react-native-unistyles'
import {PnyxLogomark} from './PnyxLogomark'

type Props = {
  width?: number
  /** Force both mark and wordmark to one color; omit for brand-violet mark + theme-text wordmark. */
  variant?: 'light' | 'dark'
}

/** Horizontal lockup: amphitheater mark beside the Pnyx wordmark. */
export const PnyxPrimaryLogo = ({width = 200, variant}: Props) => {
  const {theme} = useUnistyles()
  const forced = variant ? (variant === 'light' ? '#FFFFFF' : '#0D0F0D') : undefined
  const markColor = forced ?? theme.colors.logoPrimary
  const wordColor = forced ?? theme.colors.textDefault
  const markWidth = width * 0.19
  return (
    <View style={{width, flexDirection: 'row', alignItems: 'center', gap: width * 0.05}}>
      <PnyxLogomark width={markWidth} color={markColor} />
      <Text
        style={{
          color: wordColor,
          fontSize: width * 0.14,
          fontWeight: '700',
          letterSpacing: width * 0.006,
        }}
      >
        Pnyx
      </Text>
    </View>
  )
}
