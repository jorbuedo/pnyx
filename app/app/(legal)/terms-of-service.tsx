/**
 * Terms of Service screen — the shared legal-document viewer bound to the ToS
 * title + loader.
 *
 * @module
 */

import {loadTOS} from '../../src/legal'
import {useI18n} from '../../src/providers'
import {LegalDocumentScreen} from '../../src/screens/LegalDocumentScreen'

export default function TermsOfServiceScreen() {
  const {t} = useI18n()
  return <LegalDocumentScreen title={t('legal.termsOfServiceTitle')} load={loadTOS} testID="terms-of-service" />
}
