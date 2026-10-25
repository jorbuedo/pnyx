/**
 * Share the page you are on — into Pnyx, or out to the OS.
 *
 * **Nothing is ever posted from here.** Every in-app target hands the URL to that surface's composer
 * through the {@link module:../../services/composer-draft} registry and navigates there, so the user
 * picks the recipient and presses send with the link in front of them. That is the same rule the
 * co-sign and shared-wallet-invite flows follow, and it matters more in a circle than in a DM: the
 * content service has no delete route, so a post is permanent.
 *
 * "Send in a message" goes to the DM inbox rather than a peer list of its own — that surface already
 * lists Notes and every conversation, already forwards a draft to the thread it opens, and a second
 * picker would be a second answer to the same question.
 *
 * **The two targets get different spellings of the link.** A Pnyx conversation gets a CIP-0158
 * `browse` URI, which the thread draws as a card naming the host; the OS share sheet gets the ordinary
 * `https:` URL, because nothing outside this app can open the other one. See
 * {@link module:../../services/browser-share-link}.
 *
 * @module
 */

import {router} from 'expo-router'
import {Share} from 'react-native'
import {logger} from '../../logger'
import {useI18n} from '../../providers'
import {useCommunities} from '../../screens/home/useCommunities'
import {inAppShareBody} from '../../services/browser-share-link'
import {registerComposerDraft} from '../../services/composer-draft'
import {Modal} from '../Modal'
import {SettingsRow} from '../SettingsRow'

export type BrowserShareSheetProps = {
  readonly visible: boolean
  /** The page's URL. `null` closes the sheet — there is nothing to share from the start page. */
  readonly url: string | null
  readonly onClose: () => void
}

export const BrowserShareSheet = ({visible, url, onClose}: BrowserShareSheetProps) => {
  const {t} = useI18n()
  const {circles, joinedIds} = useCommunities()
  const joined = (circles ?? []).filter((circle) => joinedIds.has(circle.id))

  /** Register the card link and leave the browser for `path`, which seeds its composer from the draft. */
  const handOff = (path: string) => {
    if (url === null) return
    const draft = registerComposerDraft(inAppShareBody(url))
    onClose()
    router.push(`${path}${path.includes('?') ? '&' : '?'}draft=${draft}` as never)
  }

  return (
    <Modal
      visible={visible && url !== null}
      onClose={onClose}
      position="bottom"
      title={t('browser.share.title')}
      showDragIndicator
      testID="browser-share-sheet"
    >
      <SettingsRow
        label={t('browser.share.message')}
        description={t('browser.share.messageSubtitle')}
        leftIcon="chat"
        onPress={() => handOff('/community')}
        showBorder
        testID="browser-share-message"
      />

      {joined.map((circle, index) => (
        <SettingsRow
          key={circle.id}
          label={circle.name}
          description={t('browser.share.communitySubtitle')}
          leftIcon="hash"
          // #general is the only channel a circle links to today — see `ChannelPanel`.
          onPress={() => handOff(`/community/${circle.id}/general`)}
          showBorder={index < joined.length - 1}
          testID={`browser-share-community-${circle.id}`}
        />
      ))}

      <SettingsRow
        label={t('browser.share.otherApps')}
        leftIcon="share"
        onPress={() => {
          if (url === null) return
          onClose()
          // The plain https URL, not the card link: this leaves Pnyx, and nothing out there can open
          // a `web+cardano:` URI. The OS sheet owns the rest; a rejection here is the user dismissing it.
          void Share.share({message: url}).catch((e) => {
            logger.debug('OS share sheet closed without sharing', {origin: 'BrowserShareSheet', error: String(e)})
          })
        }}
        showBorder={false}
        testID="browser-share-other-apps"
      />
    </Modal>
  )
}
