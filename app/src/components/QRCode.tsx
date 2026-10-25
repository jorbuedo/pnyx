/**
 * QR Code component.
 *
 * Renders a QR code using the qrcode library's SVG string output.
 * On native, uses SvgXml from react-native-svg to render the SVG directly.
 * On web, uses an SVG data URI in an Image element.
 * No Canvas required, no N² View matrix, no extra dependencies.
 *
 * @module
 */

import QRCodeLib from 'qrcode'
import {memo, useEffect, useState} from 'react'
import {Image, Platform, View} from 'react-native'
import {SvgXml} from 'react-native-svg'
import {StyleSheet} from 'react-native-unistyles'

import {logger} from '../logger'
import {Typography} from './Typography'

export type QRCodeProps = {
  /** Value to encode */
  value: string
  /** QR code size */
  size?: number
  /** Background color */
  backgroundColor?: string
  /** Foreground color */
  color?: string
  /**
   * Keep the code already on screen while the next one encodes, instead of blanking first.
   *
   * ⚠️ Only for a presenter whose successive values are frames of **one** payload, where a frame
   * behind is redundant rather than wrong. An address or a token must keep the default: a stale
   * code there is a different destination, and someone scans what is on the glass.
   *
   * It also matters for update churn — blanking is a `setState` inside the effect, which React
   * counts as a nested update, and one per frame across several cycling codes is what trips
   * "maximum update depth exceeded".
   */
  keepPreviousWhileEncoding?: boolean
  /** Test ID */
  testID?: string
}

/**
 * QR code component.
 *
 * @example
 * ```tsx
 * <QRCode
 *   value="addr1..."
 *   size={200}
 * />
 * ```
 */
const QRCodeInner = ({
  value,
  size = 200,
  backgroundColor = '#FFFFFF',
  color = '#000000',
  keepPreviousWhileEncoding = false,
  testID,
}: QRCodeProps) => {
  const [svg, setSvg] = useState<string | null>(null)

  useEffect(() => {
    if (!value) {
      setSvg(null)
      return
    }

    let active = true
    // Clear previous QR immediately to avoid showing stale code during generation
    if (!keepPreviousWhileEncoding) setSvg(null)

    QRCodeLib.toString(value, {
      type: 'svg',
      errorCorrectionLevel: 'M',
      width: size,
      margin: 0,
      color: {dark: color, light: backgroundColor},
    })
      .then((svgString) => {
        if (active) setSvg(svgString)
      })
      .catch((e) => {
        logger.warn('QR code did not render', {origin: 'QRCode', error: String(e)})
        if (active) setSvg(null)
      })

    return () => {
      active = false
    }
  }, [value, size, color, backgroundColor, keepPreviousWhileEncoding])

  if (!value || !svg) {
    return (
      <View style={[styles.container, {width: size, height: size, backgroundColor}]} testID={testID}>
        <View style={styles.errorContainer}>
          <Typography variant="bodyLg_medium" style={styles.errorText}>
            QR
          </Typography>
        </View>
      </View>
    )
  }

  return (
    <View style={[styles.container, {width: size, height: size, backgroundColor}]} testID={testID}>
      {Platform.OS === 'web' ? (
        <Image
          source={{uri: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`}}
          style={{width: size, height: size}}
          resizeMode="contain"
        />
      ) : (
        <SvgXml xml={svg} width={size} height={size} />
      )}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  // Deliberately square. A radius here clips the corner of the top-left and top-right finder
  // patterns — the three squares a scanner locates the symbol by — and the smaller the modules,
  // the more of them it eats. Rounding belongs on the card around it, outside the quiet zone.
  container: {},
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: theme.colors.backgroundAlternative,
  },
  errorText: {
    color: theme.colors.textAlternative,
  },
}))

/**
 * Memoised, and it is not a micro-optimisation: every render re-parses the SVG through `SvgXml`, and a
 * dense code is 89×89 modules of it. Measured on the agent-pairing screen, whose four `setState` calls
 * during one "pair" produced **three** renders here for one encode — two of them with identical props.
 *
 * Exact rather than approximate: every prop is a primitive, so a shallow compare is a full compare.
 */
export const QRCode = memo(QRCodeInner)
