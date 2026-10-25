/**
 * Sheets Showcase.
 *
 * Every visibility-driven overlay in one place — modals, pickers and bottom
 * sheets. Each opens from a button rather than rendering inline, which is also
 * the only way to see how they dismiss.
 *
 * @module
 */

import {useState} from 'react'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {BackupAdvisorySheet} from '../../components/BackupAdvisorySheet/BackupAdvisorySheet'
import {Button} from '../../components/Buttons'
import {ContactPickerModal} from '../../components/ContactPickerModal'
import {LegalConsentSheet, LegalDocView, LegalLinksCallout} from '../../components/legal/LegalConsentSheet'
import {Modal} from '../../components/Modal'
import {TosUpdateModal} from '../../components/TosUpdateModal'
import {Typography} from '../../components/Typography'
import {WalletMoreSheet} from '../../components/WalletMoreSheet'
import {ShowcaseItem, ShowcaseSection} from '../components'

/** Filler for the ScrollableModal body. */
const SCROLL_ROWS = Array.from({length: 12}, (_, i) => `Row ${i + 1}`)

type Open = 'none' | 'contacts' | 'tos' | 'walletMore' | 'backup' | 'scrollable' | 'consent' | 'legalDoc'

export const SheetsShowcase = () => {
  const [open, setOpen] = useState<Open>('none')
  const close = () => setOpen('none')

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection title="Inline pickers" description="Render in place; open their own overlay on press.">
        <ShowcaseItem label="LegalLinksCallout">
          <View style={styles.full}>
            <LegalLinksCallout
              calloutText="By continuing you agree to the {terms} and {privacy}."
              termsLabel="Terms of Service"
              privacyLabel="Privacy Policy"
              onShowLegal={() => setOpen('legalDoc')}
            />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Modals">
        <ShowcaseItem label="ContactPickerModal">
          <Button label="Open ContactPickerModal" onPress={() => setOpen('contacts')} />
        </ShowcaseItem>
        <ShowcaseItem label="TosUpdateModal">
          <Button label="Open TosUpdateModal" onPress={() => setOpen('tos')} />
        </ShowcaseItem>
        <ShowcaseItem label="Modal — scrollable">
          <Button label="Open scrollable Modal" onPress={() => setOpen('scrollable')} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Bottom sheets">
        <ShowcaseItem label="WalletMoreSheet">
          <Button label="Open WalletMoreSheet" onPress={() => setOpen('walletMore')} />
        </ShowcaseItem>
        <ShowcaseItem label="BackupAdvisorySheet">
          <Button label="Open BackupAdvisorySheet" onPress={() => setOpen('backup')} />
        </ShowcaseItem>
        <ShowcaseItem label="LegalConsentSheet">
          <Button label="Open LegalConsentSheet" onPress={() => setOpen('consent')} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ContactPickerModal visible={open === 'contacts'} onClose={close} onSelect={close} />
      <TosUpdateModal visible={open === 'tos'} onDismiss={close} />
      <WalletMoreSheet visible={open === 'walletMore'} onClose={close} />
      {open === 'backup' ? (
        <BackupAdvisorySheet walletName="Playground Wallet" onDismiss={close} onLater={close} onBackUpNow={close} />
      ) : null}
      <Modal
        visible={open === 'scrollable'}
        onClose={close}
        title="Scrollable"
        description="Long content scrolls inside the modal."
      >
        <View style={styles.full}>
          {SCROLL_ROWS.map((row) => (
            <Typography key={row} variant="bodyMd_regular">
              {row}
            </Typography>
          ))}
        </View>
      </Modal>
      {open === 'consent' ? (
        <LegalConsentSheet
          title="Before you continue"
          subtitle="A quick word on how this wallet handles your keys."
          ctaLabel="I understand"
          calloutText="By continuing you agree to the {terms} and {privacy}."
          termsLabel="Terms of Service"
          privacyLabel="Privacy Policy"
          onAgree={close}
        />
      ) : null}
      {open === 'legalDoc' ? <LegalDocView kind="terms" onBack={close} /> : null}
    </ScrollView>
  )
}

const styles = StyleSheet.create(({spacing}) => ({
  container: {
    flex: 1,
  },
  content: {
    paddingVertical: spacing.spacing16,
    gap: spacing.spacing24,
  },
  full: {
    width: '100%',
    gap: spacing.spacing8,
  },
}))
