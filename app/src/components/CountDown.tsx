/**
 * CountDown component.
 *
 * Displays a countdown timer with customizable format.
 *
 * @module
 */

import {type ReactElement, useEffect, useState} from 'react'
import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {Typography} from './Typography'

export type CountDownProps = {
  /** Target timestamp (milliseconds) */
  targetTime: number
  /** Completion callback */
  onComplete?: (() => void) | undefined
  /** Whether to show days */
  showDays?: boolean | undefined
  /** Whether to show hours */
  showHours?: boolean | undefined
  /** Whether to show minutes */
  showMinutes?: boolean | undefined
  /** Whether to show seconds */
  showSeconds?: boolean | undefined
  /** Separator between time units */
  separator?: string | undefined
  /** Test ID for e2e testing */
  testID?: string | undefined
}

type TimeLeft = {
  days: number
  hours: number
  minutes: number
  seconds: number
}

const calculateTimeLeft = (targetTime: number): TimeLeft => {
  const now = Date.now()
  const difference = targetTime - now

  if (difference <= 0) {
    return {days: 0, hours: 0, minutes: 0, seconds: 0}
  }

  return {
    days: Math.floor(difference / (1000 * 60 * 60 * 24)),
    hours: Math.floor((difference / (1000 * 60 * 60)) % 24),
    minutes: Math.floor((difference / (1000 * 60)) % 60),
    seconds: Math.floor((difference / 1000) % 60),
  }
}

const padZero = (num: number): string => num.toString().padStart(2, '0')

/**
 * CountDown component.
 *
 * A countdown timer that ticks down to a target time.
 *
 * @example
 * ```tsx
 * <CountDown
 *   targetTime={Date.now() + 3600000} // 1 hour from now
 *   onComplete={() => console.log('Timer complete!')}
 *   showDays={false}
 * />
 * ```
 */
export const CountDown = ({
  targetTime,
  onComplete,
  showDays = true,
  showHours = true,
  showMinutes = true,
  showSeconds = true,
  separator = ':',
  testID,
}: CountDownProps): ReactElement => {
  const [timeLeft, setTimeLeft] = useState(() => calculateTimeLeft(targetTime))

  useEffect(() => {
    const interval = setInterval(() => {
      const newTimeLeft = calculateTimeLeft(targetTime)
      setTimeLeft(newTimeLeft)

      if (newTimeLeft.days === 0 && newTimeLeft.hours === 0 && newTimeLeft.minutes === 0 && newTimeLeft.seconds === 0) {
        clearInterval(interval)
        onComplete?.()
      }
    }, 1000)

    return () => clearInterval(interval)
  }, [targetTime, onComplete])

  const parts: string[] = []
  if (showDays && timeLeft.days > 0) parts.push(`${timeLeft.days}d`)
  if (showHours) parts.push(padZero(timeLeft.hours))
  if (showMinutes) parts.push(padZero(timeLeft.minutes))
  if (showSeconds) parts.push(padZero(timeLeft.seconds))

  return (
    <View style={styles.container} testID={testID}>
      <Typography variant="headingMd" style={styles.label}>
        {parts.join(separator)}
      </Typography>
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  label: {
    color: theme.colors.textDefault,
  },
}))
