/**
 * Choose-and-confirm for any code the user sets.
 *
 * Two passes over {@link PinEntryScreen}: enter, then repeat. A mismatch
 * restarts rather than reporting which digit differed.
 *
 * @module
 */

import {useCallback, useState} from 'react'
import {useI18n} from '../providers/I18nProvider'
import {PinEntryScreen} from './PinEntryScreen'

export type PinSetupFlowProps = {
  readonly length: number
  /** Copy for the first pass. The confirm pass has its own fixed prompt. */
  readonly title: string
  /** Called once both passes agree. Return an error key to surface, or undefined on success. */
  readonly onComplete: (code: string) => Promise<string | undefined>
  readonly testID?: string | undefined
}

export function PinSetupFlow({length, title, onComplete, testID}: PinSetupFlowProps) {
  const {t} = useI18n()
  const [first, setFirst] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  const handle = useCallback(
    async (code: string): Promise<boolean> => {
      if (first === undefined) {
        setFirst(code)
        setNotice(undefined)
        return true
      }

      if (code !== first) {
        setFirst(undefined)
        setNotice(t('settings.security.pin.mismatch'))
        return false
      }

      const error = await onComplete(code)
      if (error !== undefined) {
        setFirst(undefined)
        setNotice(error)
        return false
      }
      return true
    },
    [first, onComplete, t],
  )

  return (
    <PinEntryScreen
      length={length}
      onSubmit={handle}
      title={first === undefined ? title : t('settings.security.pin.confirmTitle')}
      errorText={notice}
      testID={testID}
    />
  )
}
