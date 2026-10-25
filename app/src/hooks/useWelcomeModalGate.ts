/**
 * Decide which legal modal (if any) the home screen should mount, so
 * `HomeScreen` can render `<TosUpdateModal>` inline over the home layout
 * without custom routing.
 *
 *  - `'tos-update'` — a lightweight re-accept prompt for users who previously
 *    accepted but whose stored acceptance is now older than `TOS_PINNED_AT`
 *    (the wording changed).
 *  - `null` — nothing to show (already accepted, still loading, or a fresh
 *    user whose acceptance is owned by onboarding).
 *
 * The legacy-migration `'welcome'` carousel is gone with the migration flow.
 *
 * One-shot: once dismissed in-session it stays dismissed. Persistent
 * acceptance is the `useLegalAgreement.agree` write fired from the modal.
 *
 * @module
 */

import {useEffect, useState} from 'react'
import {useLegalAgreement} from '../legal/useLegalAgreement'

export type LegalModalTarget = 'tos-update'

export const useWelcomeModalGate = (): {
  readonly modal: LegalModalTarget | null
  readonly dismiss: () => void
} => {
  const {accepted, acceptedAt, isLoading: isLegalLoading} = useLegalAgreement()
  const [target, setTarget] = useState<LegalModalTarget | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (target || dismissed) return
    if (isLegalLoading) return
    if (accepted) return
    // Re-accept only: the user accepted before but the pinned ToS version
    // moved past their acceptance. A never-accepted user (acceptedAt === null)
    // is left to onboarding — no modal here.
    if (acceptedAt !== null) {
      setTarget('tos-update')
    }
  }, [target, dismissed, accepted, acceptedAt, isLegalLoading])

  return {
    modal: dismissed ? null : target,
    dismiss: () => setDismissed(true),
  }
}
