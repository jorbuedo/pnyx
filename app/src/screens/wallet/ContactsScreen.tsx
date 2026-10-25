/**
 * Contacts / address book: list saved recipients, add a new one (name + address), and delete.
 * Contacts are surfaced in the send recipient input via {@link ContactPickerModal}.
 *
 * The chain is **read from the address** rather than chosen — `resolveContactChain` classifies and
 * validates in one step, so the chain icon beside each row states a fact instead of a default. Both
 * rails the send funnel can pay are accepted.
 *
 * @module
 */

import {Effect} from 'effect'
import {useCallback, useEffect, useMemo, useState} from 'react'
import {FlatList, View} from 'react-native'
import {StyleSheet, withUnistyles} from 'react-native-unistyles'
import {Address} from '../../components/Address'
import {Button, ButtonIcon} from '../../components/Buttons'
import {ChainRow} from '../../components/ChainRow'
import {Modal} from '../../components/Modal/Modal'
import {SafeAreaViewWrapper} from '../../components/SafeAreaViewWrapper'
import {TextInput} from '../../components/TextInput'
import {Typography} from '../../components/Typography'
import {useToast} from '../../hooks/useToast'
import {useConfig, useI18n} from '../../providers'
import {type Contact, isValidContactName, newContactId, platformContactsStore} from '../../services/contacts'
import {resolveContactChain} from '../../services/contacts/chain-for-address'

/** Trailing delete action with the shared 24-box icon metrics, error-tinted. */
const DeleteButtonIcon = withUnistyles(ButtonIcon, (theme) => ({
  iconProps: {color: theme.colors.errorDefault},
}))

const styles = StyleSheet.create((theme) => ({
  content: {padding: theme.spacing.spacing16, gap: theme.spacing.spacing12, flexGrow: 1},
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.spacing.spacing8,
    padding: theme.spacing.spacing24,
  },
  muted: {color: theme.colors.textMuted},
  form: {gap: theme.spacing.spacing12},
  separator: {height: theme.spacing.spacing12},
}))

export function ContactsScreen() {
  const {t} = useI18n()
  const {network} = useConfig()
  const {showToast} = useToast()
  const store = useMemo(() => platformContactsStore(), [])

  const [contacts, setContacts] = useState<readonly Contact[]>([])
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [note, setNote] = useState('')
  const [saving, setSaving] = useState(false)

  const reload = useCallback(() => {
    void Effect.runPromise(store.list()).then(setContacts)
  }, [store])

  useEffect(() => {
    reload()
  }, [reload])

  const resetForm = useCallback(() => {
    setName('')
    setAddress('')
    setNote('')
  }, [])

  const onSave = useCallback(async () => {
    if (!isValidContactName(name)) {
      showToast({variant: 'error', message: t('contacts.errors.name')})
      return
    }
    const resolved = await Effect.runPromise(resolveContactChain(address, network))
    if (!resolved.ok) {
      showToast({
        variant: 'error',
        message: t(resolved.reason === 'dust-address' ? 'contacts.errors.dustAddress' : 'contacts.errors.address'),
      })
      return
    }
    setSaving(true)
    const contact: Contact = {
      id: newContactId(),
      name,
      addressBech32: address.trim(),
      chain: resolved.chain,
      ...(note.trim().length > 0 ? {note: note.trim()} : {}),
      createdAt: Date.now(),
    }
    const result = await Effect.runPromise(Effect.either(store.save(contact)))
    setSaving(false)
    if (result._tag === 'Left') {
      showToast({variant: 'error', message: t('contacts.errors.saveFailed')})
      return
    }
    resetForm()
    setAdding(false)
    reload()
    showToast({variant: 'success', message: t('contacts.saved')})
  }, [name, address, note, network, store, showToast, t, resetForm, reload])

  const onDelete = useCallback(
    (id: string) => {
      void Effect.runPromise(Effect.either(store.remove(id))).then((result) => {
        if (result._tag === 'Right') {
          reload()
          showToast({variant: 'neutral', message: t('contacts.removed')})
        }
      })
    },
    [store, reload, showToast, t],
  )

  return (
    <SafeAreaViewWrapper edges={['bottom']} contentContainerStyle={styles.content}>
      <FlatList
        data={contacts}
        keyExtractor={(c) => c.id}
        renderItem={({item}) => (
          <ChainRow
            chain={item.chain}
            name={item.name}
            subtitleContent={<Address address={item.addressBech32} modalTitle={item.name} />}
            rightAlignTop
            testID={`contact-row-${item.id}`}
            right={
              <DeleteButtonIcon
                icon="delete"
                size="sm"
                variant="naked"
                onPress={() => onDelete(item.id)}
                containerProps={{accessibilityLabel: t('contacts.remove')}}
                testID={`contact-delete-${item.id}`}
              />
            }
          />
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <View style={styles.center}>
            <Typography variant="bodyMd_regular" style={styles.muted}>
              {t('contacts.empty')}
            </Typography>
          </View>
        }
        contentContainerStyle={contacts.length === 0 ? styles.center : undefined}
      />

      <Button label={t('contacts.add')} onPress={() => setAdding(true)} fullWidth testID="contacts-add" />

      <Modal
        visible={adding}
        onClose={() => setAdding(false)}
        position="bottom"
        title={t('contacts.addTitle')}
        testID="contacts-add-modal"
      >
        <View style={styles.form}>
          <TextInput
            fullWidth
            label={t('contacts.name')}
            placeholder={t('contacts.namePlaceholder')}
            value={name}
            onChange={setName}
            testID="contacts-name"
          />
          <TextInput
            fullWidth
            label={t('contacts.address')}
            placeholder={t('contacts.addressPlaceholder')}
            value={address}
            onChange={setAddress}
            autoCapitalize="none"
            autoCorrect={false}
            testID="contacts-address"
          />
          <TextInput
            fullWidth
            label={t('contacts.note')}
            placeholder={t('contacts.notePlaceholder')}
            value={note}
            onChange={setNote}
            testID="contacts-note"
          />
          <Button
            label={t('contacts.save')}
            onPress={onSave}
            fullWidth
            isLoading={saving}
            isDisabled={saving}
            testID="contacts-save"
          />
        </View>
      </Modal>
    </SafeAreaViewWrapper>
  )
}
