import {useId} from 'react'
import Svg, {Circle, ClipPath, Defs, G, Path, Rect} from 'react-native-svg'

type Props = {size?: number}

export const Midnight = ({size = 40}: Props) => {
  const id = useId()
  const clipId = `midnight_clip_${id}`

  return (
    <Svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <Circle cx="20" cy="20" r="20" fill="#121631" />
      <G clipPath={`url(#${clipId})`}>
        <Path
          fill="white"
          d="M19.832 6C12.193 6 6 12.1924 6 19.832C6 27.4716 12.1924 33.664 19.832 33.664C27.4716 33.664 33.664 27.4709 33.664 19.832C33.664 12.193 27.4709 6 19.832 6ZM19.832 31.1134C13.6113 31.1134 8.55058 26.0527 8.55058 19.832C8.55058 13.6113 13.6113 8.55058 19.832 8.55058C26.0527 8.55058 31.1134 13.6113 31.1134 19.832C31.1134 26.0527 26.0527 31.1134 19.832 31.1134Z"
        />
        <Path fill="white" d="M21.1302 18.5337H18.5335V21.1304H21.1302V18.5337Z" />
        <Path fill="white" d="M21.1302 14.4337H18.5335V17.0305H21.1302V14.4337Z" />
        <Path fill="white" d="M21.1302 10.3354H18.5335V12.9321H21.1302V10.3354Z" />
      </G>
      <Defs>
        <ClipPath id={clipId}>
          <Rect x="6" y="6" width="28" height="28" fill="white" />
        </ClipPath>
      </Defs>
    </Svg>
  )
}
