/**
 * Branded logo tile for each search engine option.
 *
 * Each engine has a custom SVG glyph and a tile background colour — Google
 * sits on white because the multi-colour G doesn't read against the brand
 * colour the way a flat mark would.
 *
 * @module
 */

import {View} from 'react-native'
import Svg, {Circle, Ellipse, G, Line, Path, Rect, Text as SvgText} from 'react-native-svg'
import {StyleSheet} from 'react-native-unistyles'
import type {BrowserSearchEngine} from '../../services/browser-prefs-storage'

type SearchEngineLogoProps = {
  engine: BrowserSearchEngine
  /** Outer tile size in px. Defaults to 36. */
  size?: number
}

const ENGINE_TILE_COLOR: Record<BrowserSearchEngine, string> = {
  google: '#FFFFFF',
  duckduckgo: '#DE5833',
  brave: '#FB542B',
  ecosia: '#1DA462',
  startpage: '#4A90D9',
  bing: '#0078D4',
  yahooJapan: '#FF0033',
  naver: '#03C75A',
  baidu: '#2932E1',
  yandex: '#FC3F1D',
}

export const SearchEngineLogo = ({engine, size = 36}: SearchEngineLogoProps) => {
  // SVG glyph is sized at ~55% of the tile (20 in a 36 tile).
  const glyph = Math.round(size * 0.56)
  return (
    <View style={[styles.tile, {width: size, height: size, backgroundColor: ENGINE_TILE_COLOR[engine]}]}>
      {renderGlyph(engine, glyph)}
    </View>
  )
}

const renderGlyph = (engine: BrowserSearchEngine, size: number) => {
  switch (engine) {
    case 'google':
      return (
        <Svg width={size} height={size} viewBox="0 0 48 48">
          <Path
            fill="#4285F4"
            d="M45.1 24.5c0-1.56-.14-3.06-.4-4.5H24v8.51h11.84c-.51 2.75-2.06 5.08-4.39 6.64v5.52h7.11C42.7 36.68 45.1 31.04 45.1 24.5z"
          />
          <Path
            fill="#34A853"
            d="M24 46c5.94 0 10.92-1.97 14.56-5.33l-7.11-5.52c-1.97 1.32-4.49 2.1-7.45 2.1-5.73 0-10.58-3.87-12.31-9.07H4.34v5.7C7.96 41.07 15.4 46 24 46z"
          />
          <Path
            fill="#FBBC05"
            d="M11.69 28.18C11.25 26.86 11 25.45 11 24s.25-2.86.69-4.18v-5.7H4.34C2.85 17.09 2 20.45 2 24c0 3.55.85 6.91 2.34 9.88l7.35-5.7z"
          />
          <Path
            fill="#EA4335"
            d="M24 10.75c3.23 0 6.13 1.11 8.41 3.29l6.31-6.31C34.91 4.18 29.93 2 24 2 15.4 2 7.96 6.93 4.34 14.12l7.35 5.7c1.73-5.2 6.58-9.07 12.31-9.07z"
          />
        </Svg>
      )
    case 'duckduckgo':
      return (
        <Svg width={size} height={size} viewBox="0 0 36 36" fill="none">
          <Ellipse cx="14" cy="23" rx="10" ry="7" fill="white" />
          <Circle cx="24" cy="14" r="9" fill="white" />
          <Circle cx="27" cy="12" r="2" fill="#DE5833" />
          <Circle cx="27.8" cy="11.2" r="0.9" fill="white" />
          <Path d="M32 14 L37 12.5 L37 15.5 Z" fill="#F5A623" />
          <Path d="M5 23 Q2 20 5 17 Q6 22 5 23Z" fill="white" />
        </Svg>
      )
    case 'brave':
      return (
        <Svg width={size} height={size} viewBox="0 0 36 36" fill="none">
          <Circle cx="18" cy="20" r="13" fill="rgba(255,255,255,0.25)" />
          <Ellipse cx="18" cy="21" rx="9" ry="10" fill="white" />
          <Path d="M9 13 L6 5 L13 10Z" fill="white" />
          <Path d="M27 13 L30 5 L23 10Z" fill="white" />
          <Path d="M9.5 12 L7.5 7 L12 10Z" fill="#FB542B" />
          <Path d="M26.5 12 L28.5 7 L24 10Z" fill="#FB542B" />
          <Ellipse cx="14" cy="19" rx="2" ry="2.2" fill="#FB542B" />
          <Ellipse cx="22" cy="19" rx="2" ry="2.2" fill="#FB542B" />
          <Path d="M16.5 22 Q18 24.5 19.5 22" stroke="#FB542B" strokeWidth="1" fill="none" />
          <Ellipse cx="18" cy="24" rx="2.5" ry="1.5" fill="#FB542B" />
          <Line x1="10" y1="24" x2="15" y2="23.5" stroke="#FB542B" strokeWidth="0.7" />
          <Line x1="10" y1="26" x2="15" y2="25" stroke="#FB542B" strokeWidth="0.7" />
          <Line x1="26" y1="24" x2="21" y2="23.5" stroke="#FB542B" strokeWidth="0.7" />
          <Line x1="26" y1="26" x2="21" y2="25" stroke="#FB542B" strokeWidth="0.7" />
        </Svg>
      )
    case 'ecosia':
      return (
        <Svg width={size} height={size} viewBox="0 0 36 36" fill="white">
          <Rect x="16" y="22" width="4" height="9" rx="2" />
          <Circle cx="18" cy="16" r="9" />
          <Circle cx="12" cy="19" r="7" />
          <Circle cx="24" cy="19" r="7" />
        </Svg>
      )
    case 'startpage':
      return (
        <Svg
          width={size}
          height={size}
          viewBox="0 0 36 36"
          fill="none"
          stroke="white"
          strokeWidth="3"
          strokeLinecap="round"
        >
          <Circle cx="15" cy="15" r="9" />
          <Line x1="22" y1="22" x2="30" y2="30" />
          <SvgText x="10" y="19" fontSize="10" fontWeight="700" fill="white" stroke="none" fontFamily="sans-serif">
            S
          </SvgText>
        </Svg>
      )
    case 'bing':
      return (
        <Svg width={size} height={size} viewBox="0 0 36 36" fill="none">
          <Rect x="9" y="5" width="5" height="26" rx="2.5" fill="white" />
          <Path d="M14 5 Q26 5 26 12 Q26 19 14 19Z" fill="rgba(255,255,255,0.7)" />
          <Path d="M14 19 Q28 19 28 27 Q28 31 14 31Z" fill="white" />
        </Svg>
      )
    case 'yahooJapan':
      return (
        <Svg width={size} height={size} viewBox="0 0 36 36" fill="white">
          <SvgText x="4" y="22" fontSize="17" fontWeight="900" fontFamily="sans-serif" fill="white">
            Y!
          </SvgText>
          <SvgText x="4" y="32" fontSize="8" fontWeight="700" fontFamily="sans-serif" fill="rgba(255,255,255,0.8)">
            JAPAN
          </SvgText>
        </Svg>
      )
    case 'naver':
      return (
        <Svg width={size} height={size} viewBox="0 0 36 36" fill="none">
          <Path d="M8 7 L8 29 L15 29 L15 19 L21 29 L28 29 L28 7 L21 7 L21 17 L15 7 Z" fill="white" />
        </Svg>
      )
    case 'baidu':
      return (
        <Svg width={size} height={size} viewBox="0 0 36 36" fill="white">
          <Ellipse cx="18" cy="22" rx="7" ry="6" />
          <Ellipse cx="18" cy="10" rx="3.5" ry="4" />
          <G originX="9" originY="15" rotation="-20">
            <Ellipse cx="9" cy="15" rx="3.5" ry="4" />
          </G>
          <G originX="27" originY="15" rotation="20">
            <Ellipse cx="27" cy="15" rx="3.5" ry="4" />
          </G>
          <G originX="11" originY="26" rotation="-35">
            <Ellipse cx="11" cy="26" rx="3" ry="3.5" />
          </G>
          <G originX="25" originY="26" rotation="35">
            <Ellipse cx="25" cy="26" rx="3" ry="3.5" />
          </G>
        </Svg>
      )
    case 'yandex':
      // No custom glyph; render a flat "Я" on the brand red.
      return (
        <Svg width={size} height={size} viewBox="0 0 36 36" fill="none">
          <SvgText x="9" y="27" fontSize="22" fontWeight="900" fontFamily="sans-serif" fill="white">
            Я
          </SvgText>
        </Svg>
      )
  }
}

const styles = StyleSheet.create(() => ({
  tile: {
    borderRadius: 12,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    overflow: 'hidden' as const,
  },
}))
