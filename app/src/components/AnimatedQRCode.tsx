/**
 * An animated (multi-frame) QR code — the "present a UR" surface.
 *
 * Wraps {@link QRCard} rather than replacing it: one frame is still one static code on the same
 * white surface every scannable code in the app gets, and this owns only the cycling. A payload
 * small enough for a single part renders as a still code, because a fountain stream of one frame
 * would blink for no reason.
 *
 * Three things make a frame scannable, and this component is where all three are decided: the
 * fragment budget below, the uppercasing at the render call, and filling the width it is given.
 *
 * @module
 */

import {fountainEncoder} from '@pnyx/ur'
import {useEffect, useMemo, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {QRCard} from './QRCard'
import {Typography} from './Typography'

/**
 * Frame budget per code. A QR at error-correction M holds far more, but a dense code is slower for
 * a phone camera to lock onto, and the fountain makes a missed frame cheap — so smaller frames
 * scan faster overall than fewer large ones. 150 keeps a typical account export and witness set
 * inside QR version 11 (61 modules); 200 pushed both a version or two higher for no gain a
 * receiver can feel.
 */
const DEFAULT_MAX_FRAGMENT_LENGTH = 150

/** ~8 fps. Fast enough to get through a sequence quickly, slow enough for a camera to lock. */
const DEFAULT_FRAME_INTERVAL_MS = 125

export type AnimatedQRCodeProps = {
  /** The CBOR payload to present. */
  readonly payload: Uint8Array
  /** Registry type, e.g. `cardano-signature`. */
  readonly urType: string
  /** Fixed edge length for the code. Omitted, it fills the width this component is given. */
  readonly size?: number
  readonly maxFragmentLength?: number
  readonly frameIntervalMs?: number
  /** Rendered under the code — a caller-supplied, translated caption. */
  readonly caption?: string
  readonly testID?: string
}

export const AnimatedQRCode = ({
  payload,
  urType,
  size,
  maxFragmentLength = DEFAULT_MAX_FRAGMENT_LENGTH,
  frameIntervalMs = DEFAULT_FRAME_INTERVAL_MS,
  caption,
  testID,
}: AnimatedQRCodeProps) => {
  const encoder = useMemo(
    () => fountainEncoder(payload, urType, maxFragmentLength),
    [payload, urType, maxFragmentLength],
  )

  const [frame, setFrame] = useState(() => encoder.nextPart())

  useEffect(() => {
    // A single-part UR is one fixed code; cycling it would flicker without conveying anything.
    if (encoder.isSinglePart) {
      setFrame(encoder.nextPart())
      return
    }
    setFrame(encoder.nextPart())
    const timer = setInterval(() => setFrame(encoder.nextPart()), frameIntervalMs)
    return () => clearInterval(timer)
  }, [encoder, frameIntervalMs])

  return (
    <View style={styles.container} testID={testID}>
      {/* Uppercased for the QR only. A UR is case-insensitive by design (BCR-2020-005) and the
          alphanumeric charset has no lowercase, so the canonical spelling costs 8 bits a character
          where this costs 5.5 — a version 17 symbol where this is a 13. Receivers lowercase on the
          way in, `decodeUr` included. */}
      <QRCard
        value={frame.toUpperCase()}
        // Successive frames are parts of one payload, so the code already on screen is redundant
        // rather than wrong — and blanking between frames is a nested update per frame per code.
        keepPreviousWhileEncoding={!encoder.isSinglePart}
        {...(size === undefined ? {fill: true} : {size})}
        {...(testID === undefined ? {} : {testID: `${testID}-code`})}
      />
      {caption === undefined ? null : (
        <Typography variant="bodySm_regular" style={styles.caption}>
          {caption}
        </Typography>
      )}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    // Not `center`: the card decides for itself whether it stretches or hugs its code.
    alignItems: 'stretch',
    gap: theme.spacing.spacing8,
  },
  caption: {
    color: theme.colors.textMuted,
    textAlign: 'center',
  },
}))
