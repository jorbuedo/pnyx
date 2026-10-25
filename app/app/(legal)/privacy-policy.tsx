/**
 * Privacy Policy screen — the shared legal-document viewer bound to the
 * Privacy Policy title + loader.
 *
 * @module
 */

import {loadPrivacyPolicy} from '../../src/legal'
import {useI18n} from '../../src/providers'
import {LegalDocumentScreen} from '../../src/screens/LegalDocumentScreen'

export default function PrivacyPolicyScreen() {
  const {t} = useI18n()
  return <LegalDocumentScreen title={t('legal.privacyPolicyTitle')} load={loadPrivacyPolicy} testID="privacy-policy" />
}
