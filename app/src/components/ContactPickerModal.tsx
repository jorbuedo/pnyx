/**
 * Canonical "pick a saved contact" sheet. Lists persisted contacts (optionally filtered to a set of
 * chain namespaces) as ChainRows and reports the chosen one. Shared by the send recipient field and
 * any future recipient picker.
 *
 * Filtering is by **namespace**, not chain id, because a contact's chain records which chain the
 * address is for and never which network — the same rule its validation follows. Filtering on
 * `cardano:mainnet` would hide a contact the send flow can pay perfectly well.
 *
 * @module
 */

import {type ChainId, type ChainNamespace, getChainNamespace} from '@pnyx/config'
import {Effect} from 'effect'
import {useEffect, useMemo, useState} from 'react'
import {FlatList, Pressable, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {useOwnWalletRecipients} from '../hooks/useOwnWalletRecipients'
import {useI18n} from '../providers'
import {type Contact, platformContactsStore} from '../services/contacts'
import {truncateWide} from '../utils/truncate'
import {Accordion} from './Accordion'
import {ChainRow} from './ChainRow'
import {Modal} from './Modal/Modal'
import {Typography} from './Typography'

const styles = StyleSheet.create((theme) => ({
  empty: {padding: theme.spacing.spacing24, alignItems: 'center'},
  muted: {color: theme.colors.textMuted},
  separator: {height: theme.spacing.spacing8},
  ownWallets: {marginBottom: theme.spacing.spacing8},
  // The accordion's children get no gap from the list, so its rows need their own.
  ownRows: {gap: theme.spacing.spacing8},
}))

/**
 * What the sheet reports back.
 *
 * Not a `Contact`: your own wallets are pickable here too, and they are not contacts — synthesising
 * one would mean inventing an id and a `createdAt` for a row nobody saved.
 */
export type PickedRecipient = {
  readonly name: string
  readonly address: string
  readonly chain: ChainId
}

export type ContactPickerModalProps = {
  readonly visible: boolean
  readonly onClose: () => void
  readonly onSelect: (picked: PickedRecipient) => void
  /** Chain namespaces to offer. Omitted lists every contact. */
  readonly namespaces?: readonly ChainNamespace[]
}

export const ContactPickerModal = ({visible, onClose, onSelect, namespaces}: ContactPickerModalProps) => {
  const {t} = useI18n()
  const store = useMemo(() => platformContactsStore(), [])
  const [contacts, setContacts] = useState<readonly Contact[]>([])

  useEffect(() => {
    if (!visible) return
    void Effect.runPromise(store.list()).then((all) =>
      setContacts(namespaces === undefined ? all : all.filter((c) => namespaces.includes(getChainNamespace(c.chain)))),
    )
  }, [visible, namespaces, store])

  /**
   * Your own wallets, collapsed.
   *
   * Collapsed because they are not who you usually pay, and present because they are the recipients
   * nobody should have to paste — and the ones an address book could never hold, since they are not
   * contacts. Only the chains each wallet actually has: a hardware wallet gets no Midnight row.
   */
  const {recipients: ownWallets} = useOwnWalletRecipients(visible)
  const ownRows = useMemo(
    () =>
      namespaces === undefined ? ownWallets : ownWallets.filter((r) => namespaces.includes(getChainNamespace(r.chain))),
    [ownWallets, namespaces],
  )

  return (
    <Modal
      visible={visible}
      onClose={onClose}
      position="bottom"
      title={t('contacts.pickTitle')}
      testID="contact-picker"
    >
      <FlatList
        data={contacts}
        keyExtractor={(c) => c.id}
        ListHeaderComponent={
          ownRows.length === 0 ? null : (
            <View style={styles.ownWallets}>
              <Accordion
                title={t('contacts.ownWallets')}
                description={t('contacts.ownWalletsHint')}
                testID="contact-pick-own"
              >
                <View style={styles.ownRows}>
                  {ownRows.map((row) => (
                    <Pressable
                      key={`${row.groupId}:${row.chain}`}
                      onPress={() => {
                        onSelect({name: row.walletName, address: row.address, chain: row.chain})
                        onClose()
                      }}
                      testID={`contact-pick-own-${row.groupId}-${row.chain}`}
                    >
                      <ChainRow chain={row.chain} name={row.walletName} subtitle={truncateWide(row.address)} />
                    </Pressable>
                  ))}
                </View>
              </Accordion>
            </View>
          )
        }
        renderItem={({item}) => (
          <Pressable
            onPress={() => {
              onSelect({name: item.name, address: item.addressBech32, chain: item.chain})
              onClose()
            }}
            testID={`contact-pick-${item.id}`}
          >
            <ChainRow chain={item.chain} name={item.name} subtitle={truncateWide(item.addressBech32)} />
          </Pressable>
        )}
        ItemSeparatorComponent={() => <View style={styles.separator} />}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Typography variant="bodyMd_regular" style={styles.muted}>
              {t('contacts.empty')}
            </Typography>
          </View>
        }
      />
    </Modal>
  )
}
