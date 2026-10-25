import Svg, {Path} from 'react-native-svg'

type Props = {size?: number}

export const Ethereum = ({size = 40}: Props) => (
  <Svg width={size} height={size} viewBox="0 0 40 40" fill="none">
    <Path
      fill="#627EEA"
      d="M20 40C31.0457 40 40 31.0457 40 20C40 8.9543 31.0457 0 20 0C8.9543 0 0 8.9543 0 20C0 31.0457 8.9543 40 20 40Z"
    />
    <Path fill="white" fillOpacity={0.602} d="M20.6233 4.99727V16.0853L29.9945 20.2734L20.6233 4.99727Z" />
    <Path fill="white" d="M20.6233 4.99727L11.2521 20.2734L20.6233 16.0853V4.99727Z" />
    <Path fill="white" fillOpacity={0.602} d="M20.6233 27.4576V34.9918L30 22.0175L20.6233 27.4576Z" />
    <Path fill="white" d="M20.6233 34.9918V27.4576L11.2521 22.0175L20.6233 34.9918Z" />
    <Path fill="white" fillOpacity={0.2} d="M20.6233 25.7135L29.9945 20.2734L20.6233 16.0853V25.7135Z" />
    <Path fill="white" fillOpacity={0.602} d="M11.2521 20.2734L20.6233 25.7135V16.0853L11.2521 20.2734Z" />
  </Svg>
)
