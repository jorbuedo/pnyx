/**
 * A field that asks for a date and a time, through the platform's own picker.
 *
 * Android has no combined date+time dialog, so it chains the two: the date is
 * settled first and its result seeds the time dialog. iOS has one, shown in a
 * sheet with an explicit Done — an inline picker that wrote on every scroll tick
 * would commit values the user was only passing through.
 *
 * The web build lives in `DateTimeField.web.tsx`; the picker dependency renders
 * `null` there.
 *
 * @module
 */

import DateTimePicker, {DateTimePickerAndroid} from '@react-native-community/datetimepicker'
import {useState} from 'react'
import {Platform} from 'react-native'
import {useI18n} from '../../providers'
import {Modal} from '../Modal'
import {type DateTimeFieldProps, DateTimeFieldSurface} from './DateTimeFieldSurface'

export type {DateTimeFieldProps}

/** The day from one date, the time of day from another, on the second. */
const combine = (day: Date, time: Date): Date =>
  new Date(day.getFullYear(), day.getMonth(), day.getDate(), time.getHours(), time.getMinutes(), 0, 0)

/**
 * Where an unset picker opens. Not a value — nothing is chosen until the user
 * confirms — so `minimumDate` wins over now whenever it is still ahead.
 */
const openingPosition = (value: Date | null, minimumDate: Date | undefined): Date => {
  if (value !== null) return value
  const now = new Date()
  return minimumDate !== undefined && minimumDate.getTime() > now.getTime() ? minimumDate : now
}

export const DateTimeField = (props: DateTimeFieldProps) => {
  const {value, onChange, minimumDate} = props
  const {t} = useI18n()
  const [draft, setDraft] = useState<Date | null>(null)

  const openAndroid = () => {
    DateTimePickerAndroid.open({
      value: openingPosition(value, minimumDate),
      mode: 'date',
      ...(minimumDate === undefined ? {} : {minimumDate}),
      onChange: (dayEvent, day) => {
        if (dayEvent.type !== 'set' || day === undefined) return
        DateTimePickerAndroid.open({
          value: day,
          mode: 'time',
          onChange: (timeEvent, time) => {
            if (timeEvent.type !== 'set' || time === undefined) return
            onChange(combine(day, time))
          },
        })
      },
    })
  }

  const onOpen = () => {
    if (Platform.OS === 'android') {
      openAndroid()
      return
    }
    setDraft(openingPosition(value, minimumDate))
  }

  return (
    <DateTimeFieldSurface {...props} onOpen={onOpen}>
      {draft === null ? null : (
        <Modal
          visible
          onClose={() => setDraft(null)}
          title={props.label}
          actions={[
            {label: t('common.buttons.cancel'), onPress: () => setDraft(null), variant: 'secondary'},
            {
              label: t('common.buttons.done'),
              onPress: () => {
                onChange(draft)
                setDraft(null)
              },
            },
          ]}
        >
          <DateTimePicker
            value={draft}
            mode="datetime"
            display="inline"
            {...(minimumDate === undefined ? {} : {minimumDate})}
            onChange={(_event, picked) => {
              if (picked !== undefined) setDraft(picked)
            }}
          />
        </Modal>
      )}
    </DateTimeFieldSurface>
  )
}
