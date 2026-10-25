/**
 * One recipient on the send funnel's recipients step: address/handle input
 * with inline resolution feedback, contact pick/save, and remove. Amounts are
 * NOT edited here — they belong to the amounts hub / allocate steps.
 *
 * @module
 */

import {Effect} from 'effect'
import {useEffect, useMemo, useState} from 'react'
import {Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {Button} from '../../../components/Buttons/Button'
import {ContactPickerModal} from '../../../components/ContactPickerModal'
import {Modal} from '../../../components/Modal/Modal'
import {TextInput} from '../../../components/TextInput'
import {Typography} from '../../../components/Typography'
import {UniIcon} from '../../../components/UniIcon'
import {useToast} from '../../../hooks/useToast'
import {useConfig, useI18n} from '../../../providers'
import {type Contact, isValidContactName, newContactId, platformContactsStore} from '../../../services/contacts'
import {resolveContactChain} from '../../../services/contacts/chain-for-address'
import {routeRecipient} from '../../../services/send/recipient-rail'
import {isTargetResolved, type SendRail, type SendTarget} from './state'

const styles = StyleSheet.create(({spacing, colors, borderWidth}) => ({
  row: {gap: spacing.spacing16},
  rowDivider: {
    borderTopWidth: borderWidth.s,
    borderTopColor: colors.borderDefaultWeak,
    paddingTop: spacing.spacing16,
  },
  header: {flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center'},
  headerLabel: {color: colors.textMuted, textTransform: 'uppercase', letterSpacing: 0.7},
  recipient: {gap: spacing.spacing8},
  resolved: {color: colors.successDefault, paddingTop: spacing.spacing4},
  resolving: {color: colors.textMuted, paddingTop: spacing.spacing4},
  knownContact: {flexDirection: 'row', alignItems: 'center', gap: spacing.spacing4, paddingTop: spacing.spacing4},
  knownContactName: {color: colors.successDefault},
  contactRow: {flexDirection: 'row', gap: spacing.spacing8},
  saveForm: {gap: spacing.spacing12},
}))

export type RecipientRowProps = {
  readonly index: number
  readonly target: SendTarget
  /** The flow's rail — it decides which resolution field this row's address is held in. */
  readonly rail: SendRail
  readonly canRemove: boolean
  readonly resolving: boolean
  readonly onAddressChange: (text: string) => void
  readonly onResolve: () => void
  readonly onRemove: () => void
  /** Fill the recipient with a picked/saved address and resolve it. */
  readonly onSelectContact: (address: string) => void
}

export const RecipientRow = ({
  index,
  target,
  rail,
  canRemove,
  resolving,
  onAddressChange,
  onResolve,
  onRemove,
  onSelectContact,
}: RecipientRowProps) => {
  const {t} = useI18n()
  const {network} = useConfig()
  const {showToast} = useToast()
  const [pickerOpen, setPickerOpen] = useState(false)
  const [saveOpen, setSaveOpen] = useState(false)
  const [saveName, setSaveName] = useState('')
  const [contacts, setContacts] = useState<readonly Contact[]>([])

  useEffect(() => {
    let active = true
    void Effect.runPromise(Effect.either(platformContactsStore().list())).then((result) => {
      if (active && result._tag === 'Right') setContacts(result.right)
    })
    return () => {
      active = false
    }
  }, [])

  const rawAddress = target.address.trim()
  /** The saved contact this address already belongs to, if any. */
  const knownContact = useMemo(
    () => contacts.find((c) => c.addressBech32 === rawAddress) ?? null,
    [contacts, rawAddress],
  )
  // Only an address is a valid contact address (a $handle is not) — and an address that already
  // belongs to a contact has nothing left to save. A Midnight address qualifies: it is an address,
  // and the contact store records which chain it is for.
  const canSaveContact =
    knownContact === null &&
    isTargetResolved(target, rail) &&
    (routeRecipient(rawAddress.trim(), network).rail === 'midnight' ||
      rawAddress.startsWith('addr') ||
      rawAddress.startsWith('stake'))

  const onSaveContact = () => {
    if (!isValidContactName(saveName)) {
      showToast({variant: 'error', message: t('contacts.errors.name')})
      return
    }
    // The chain comes from the address, not from whichever rail happens to be open — one classifier,
    // so a saved contact and a pasted address can never disagree about what an address is.
    void Effect.runPromise(resolveContactChain(rawAddress, network)).then((resolved) => {
      if (!resolved.ok) {
        showToast({
          variant: 'error',
          message: t(resolved.reason === 'dust-address' ? 'contacts.errors.dustAddress' : 'contacts.errors.address'),
        })
        return
      }
      const contact: Contact = {
        id: newContactId(),
        name: saveName,
        addressBech32: rawAddress.trim(),
        chain: resolved.chain,
        createdAt: Date.now(),
      }
      void Effect.runPromise(Effect.either(platformContactsStore().save(contact))).then((result) => {
        if (result._tag === 'Left') {
          showToast({variant: 'error', message: t('contacts.errors.saveFailed')})
          return
        }
        setContacts((prev) => [...prev, contact])
        setSaveOpen(false)
        setSaveName('')
        showToast({variant: 'success', message: t('contacts.saved')})
      })
    })
  }

  return (
    <View style={[styles.row, index > 0 && styles.rowDivider]}>
      <View style={styles.header}>
        <Typography variant="bodySm_medium" style={styles.headerLabel}>
          {`${t('cardanoSend.recipient')} #${index + 1}`}
        </Typography>
        {canRemove ? (
          <Pressable
            hitSlop={8}
            onPress={onRemove}
            accessibilityLabel={t('cardanoSend.removeRecipient')}
            testID={`send-remove-recipient-${index}`}
          >
            <UniIcon name="delete" width={18} height={18} uniProps={(theme) => ({color: theme.colors.errorDefault})} />
          </Pressable>
        ) : null}
      </View>

      <View style={styles.recipient}>
        <TextInput
          fullWidth
          placeholder={t('cardanoSend.recipientPlaceholder')}
          value={target.address}
          onChange={onAddressChange}
          onBlur={onResolve}
          autoCapitalize="none"
          autoCorrect={false}
          testID={`send-recipient-${index}`}
        />
        {resolving ? (
          <Typography variant="bodySm_regular" style={styles.resolving}>
            {t('cardanoSend.resolving')}
          </Typography>
        ) : knownContact !== null ? (
          <View style={styles.knownContact}>
            <UniIcon
              name="account"
              width={14}
              height={14}
              uniProps={(theme) => ({color: theme.colors.successDefault})}
            />
            <Typography variant="bodySm_regular" style={styles.knownContactName}>
              {knownContact.name}
            </Typography>
          </View>
        ) : target.resolvedName !== null ? (
          <Typography variant="bodySm_regular" style={styles.resolved}>
            {t('cardanoSend.resolvedHandle', {name: target.resolvedName})}
          </Typography>
        ) : null}
        <View style={styles.contactRow}>
          <Button
            label={t('contacts.pick')}
            variant="nakedDefault"
            size="sm"
            leftIcon="account"
            onPress={() => setPickerOpen(true)}
            testID={`send-pick-contact-${index}`}
          />
          {canSaveContact ? (
            <Button
              label={t('contacts.saveAs')}
              variant="nakedDefault"
              size="sm"
              leftIcon="plus"
              onPress={() => setSaveOpen(true)}
              testID={`send-save-contact-${index}`}
            />
          ) : null}
        </View>
      </View>

      <ContactPickerModal
        visible={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={(picked) => onSelectContact(picked.address)}
        // Both rails the send funnel can pay. Namespaces, not chain ids — a contact records the
        // chain, never the network.
        namespaces={['cardano', 'midnight']}
      />

      <Modal
        visible={saveOpen}
        onClose={() => setSaveOpen(false)}
        position="bottom"
        title={t('contacts.saveAs')}
        testID={`send-save-contact-modal-${index}`}
      >
        <View style={styles.saveForm}>
          <TextInput
            fullWidth
            label={t('contacts.name')}
            placeholder={t('contacts.namePlaceholder')}
            value={saveName}
            onChange={setSaveName}
            testID={`send-save-contact-name-${index}`}
          />
          <Button
            label={t('contacts.save')}
            onPress={onSaveContact}
            fullWidth
            testID={`send-save-contact-submit-${index}`}
          />
        </View>
      </Modal>
    </View>
  )
}
