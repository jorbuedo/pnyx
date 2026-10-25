/**
 * TosUpdateModal — lightweight re-acceptance prompt shown to existing users
 * when the pinned Terms of Service / Privacy Policy version (`TOS_PINNED_AT`)
 * changes. Unlike `WelcomeModal` this is NOT the legacy-migration welcome
 * carousel — it is a single gating step that only asks the user to review and
 * re-accept the updated terms.
 *
 * Visibility + precedence (welcome wins for first-time migrated users) is
 * decided by `useWelcomeModalGate`.
 *
 * @module
 */

import {useLegalAgreement} from '../legal/useLegalAgreement'
import {useI18n} from '../providers'
import {LegalConsentSheet} from './legal/LegalConsentSheet'
import {Modal} from './Modal'

type TosUpdateModalProps = {
  readonly visible: boolean
  readonly onDismiss: () => void
}

export function TosUpdateModal({visible, onDismiss}: TosUpdateModalProps) {
  const {t} = useI18n()
  const {agree} = useLegalAgreement()

  const onAgree = async () => {
    // Only dismiss if the acceptance actually persisted — otherwise keep the
    // gate up so the user can retry rather than slipping through unrecorded.
    if (await agree()) {
      onDismiss()
    }
  }

  // Gating — the only dismiss path is "Agree & Continue". `onClose`
  // (Android hardware-back) is a no-op so the user stays inside the gate.
  const noop = () => {}

  return (
    <Modal
      visible={visible}
      onClose={noop}
      position="bottom"
      maxHeight={0.95}
      dismissable={false}
      showDragIndicator={false}
    >
      <LegalConsentSheet
        title={t('welcome.tosUpdate.title')}
        subtitle={t('welcome.tosUpdate.sub')}
        calloutText={t('welcome.tosUpdate.callout')}
        termsLabel={t('welcome.step4.termsLink')}
        privacyLabel={t('welcome.step4.privacyLink')}
        ctaLabel={t('welcome.tosUpdate.cta')}
        onAgree={onAgree}
        ctaTestID="tos-update-cta"
      />
    </Modal>
  )
}
