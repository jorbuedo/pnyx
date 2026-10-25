/**
 * Web build of {@link DateTimeField} — the browser's own `datetime-local`
 * control.
 *
 * `@react-native-community/datetimepicker` ships no web implementation: its
 * fallback warns to the console and renders `null`, which would leave a field
 * that opens nothing on the target the app is developed against.
 *
 * The input is transparent and inert, laid over the field so the browser anchors
 * its popup to the right place; the press comes from the surface and opens the
 * popup through `showPicker()`.
 *
 * @module
 */

import {useRef} from 'react'
import {type DateTimeFieldProps, DateTimeFieldSurface} from './DateTimeFieldSurface'

export type {DateTimeFieldProps}

const pad = (n: number): string => String(n).padStart(2, '0')

/** `YYYY-MM-DDTHH:mm` in local time, which is what `datetime-local` reads and writes. */
const toInputValue = (date: Date): string =>
  `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`

const overlay = {
  position: 'absolute',
  inset: 0,
  opacity: 0,
  pointerEvents: 'none',
  border: 'none',
  padding: 0,
  margin: 0,
} as const

export const DateTimeField = (props: DateTimeFieldProps) => {
  const {value, onChange, minimumDate} = props
  const input = useRef<HTMLInputElement | null>(null)

  const onOpen = () => {
    const el = input.current
    if (el === null) return
    // Firefox below 101 has no showPicker; focusing at least puts the control in
    // reach of the keyboard rather than doing nothing.
    if (typeof el.showPicker === 'function') el.showPicker()
    else el.focus()
  }

  return (
    <DateTimeFieldSurface {...props} onOpen={onOpen}>
      <input
        ref={input}
        type="datetime-local"
        tabIndex={-1}
        aria-hidden
        style={overlay}
        value={value === null ? '' : toInputValue(value)}
        {...(minimumDate === undefined ? {} : {min: toInputValue(minimumDate)})}
        onChange={(event) => {
          const next = event.target.value
          // A datetime-local string with no offset is local time by definition,
          // which is the zone the user typed in.
          onChange(next === '' ? null : new Date(next))
        }}
      />
    </DateTimeFieldSurface>
  )
}
