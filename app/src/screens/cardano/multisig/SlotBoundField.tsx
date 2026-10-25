/**
 * One of a shared wallet's time bounds, entered as a date and shown as the slot
 * it becomes.
 *
 * The slot is the value: it is what goes into the script and what another
 * CIP-1854 wallet reproduces the address from. The date is the way in, and the
 * slot stays under the field so what the user picked and what the wallet will
 * contain are both on screen. See `slot-bound.ts` for when each is shown.
 *
 * @module
 */

import {DateTimeField} from '../../../components/DateTimeField'
import {TextInput} from '../../../components/TextInput'
import {useSlotClock} from '../../../hooks/useSlotDate'
import {formatGroupedInteger} from '../../../i18n/number-format'
import {useI18n} from '../../../providers'
import {useNumberLocale} from '../../../providers/NumberFormatProvider'
import {parseSlot, slotBoundMode} from './slot-bound'

export type SlotBoundFieldProps = {
  /** Label for the date field, e.g. "Not before". */
  label: string
  /** Label for the slot field, which names its unit — e.g. "Not before (slot)". */
  slotLabel: string
  /** What an unset bound means, e.g. "Any time". Shown under an empty field. */
  unboundedLabel: string
  /** The bound as a slot number, or empty for unbounded. */
  value: string
  onChange: (value: string) => void
  testID: string
}

export const SlotBoundField = ({label, slotLabel, unboundedLabel, value, onChange, testID}: SlotBoundFieldProps) => {
  const {t} = useI18n()
  const locale = useNumberLocale()
  const {ready, earliest, toDate, toSlot} = useSlotClock()

  const parsed = parseSlot(value)
  const slot = parsed.ok ? parsed.slot : undefined
  const date = slot === undefined ? null : toDate(slot)

  if (slotBoundMode(ready, value, date) === 'slot') {
    return (
      <TextInput
        label={slotLabel}
        value={value}
        onChange={onChange}
        keyboardType="number-pad"
        fullWidth
        testID={testID}
      />
    )
  }

  return (
    <DateTimeField
      label={label}
      value={date}
      onChange={(picked) => {
        if (picked === null) {
          onChange('')
          return
        }
        const asSlot = toSlot(picked)
        // Unreachable while the picker's minimum is the era boundary. Keeping the
        // bound beats clearing one the user did not clear.
        if (asSlot === null) return
        onChange(String(asSlot))
      }}
      clearLabel={t('multisig.create.timeLockClear', {label})}
      testID={testID}
      hint={
        slot === undefined
          ? unboundedLabel
          : t('multisig.create.timeLockSlot', {slot: formatGroupedInteger(slot, locale)})
      }
      {...(earliest === null ? {} : {minimumDate: earliest})}
    />
  )
}
