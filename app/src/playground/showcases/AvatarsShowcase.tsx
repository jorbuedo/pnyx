/**
 * Avatars Showcase.
 *
 * The four avatar components the app actually ships. They live in different
 * directories — IdentityAvatar and WalletIdenticon at components/ root,
 * PoolDrepAvatar beside them, AuthorAvatar under forum/ — so this is the only
 * place they can be compared.
 *
 * AuthorAvatar sits directly below IdentityAvatar because it delegates to it —
 * but only for a *disclosed* author. A pseudonym deliberately gets a
 * non-identifying monogram instead, so a forgeable image never becomes a
 * cross-circle badge. Both branches are shown.
 *
 * @module
 */

import {encodePnyxId} from '@pnyx/contract-client/identity'
import {ScrollView, View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'

import {AuthorAvatar} from '../../components/forum/AuthorAvatar'
import {IdentityAvatar} from '../../components/IdentityAvatar'
import {PoolDrepAvatar} from '../../components/PoolDrepAvatar'
import {WalletIdenticon} from '../../components/WalletIdenticon'
import {ShowcaseItem, ShowcaseSection} from '../components'
import {fakeImages} from '../data'

/**
 * Real `pnyx_id`s — `identityAvatarSeed` decodes bech32m and returns null for
 * anything else, so a plain hex string renders the placeholder, not a face.
 */
const PNYX_ID_A = encodePnyxId(new Uint8Array(32).fill(0x61))
const PNYX_ID_B = encodePnyxId(new Uint8Array(32).fill(0x2d))
const SEED = '9f2c7a1be4d05386'

export const AvatarsShowcase = () => {
  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <ShowcaseSection
        title="IdentityAvatar"
        description="The identity identicon — 7 call sites, the most-used avatar in the app. Derived from pnyxId."
      >
        <ShowcaseItem label="sizes" inline>
          <IdentityAvatar size={24} pnyxId={PNYX_ID_A} />
          <IdentityAvatar size={32} pnyxId={PNYX_ID_A} />
          <IdentityAvatar size={48} pnyxId={PNYX_ID_A} />
          <IdentityAvatar size={64} pnyxId={PNYX_ID_A} />
        </ShowcaseItem>
        <ShowcaseItem label="different identities" inline>
          <IdentityAvatar size={48} pnyxId={PNYX_ID_A} />
          <IdentityAvatar size={48} pnyxId={PNYX_ID_B} />
        </ShowcaseItem>
        <ShowcaseItem label="no identity (fallback)" inline>
          <IdentityAvatar size={48} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection
        title="AuthorAvatar"
        description="Delegates to IdentityAvatar for a disclosed pnyx_id; a pseudonym gets a deliberately non-identifying monogram. Not a fold candidate — the split is a privacy decision."
      >
        <ShowcaseItem label="pseudonym → monogram" inline>
          <AuthorAvatar author="lyra" />
          <AuthorAvatar author="lyra" size={48} />
          <AuthorAvatar author="castor" size={48} />
        </ShowcaseItem>
        <ShowcaseItem label="disclosed pnyx_id → identicon" inline>
          <AuthorAvatar author={PNYX_ID_A} size={48} />
          <AuthorAvatar author={PNYX_ID_B} size={48} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection
        title="WalletIdenticon"
        description="Wallet-group identicon. Jazzicon is circular because its engine clips it that way; blockies is a square grid whose corners carry signal, so it renders as a rounded square."
      >
        <ShowcaseItem label="jazzicon (default)" inline>
          <WalletIdenticon seed={SEED} size={32} />
          <WalletIdenticon seed={SEED} size={48} />
        </ShowcaseItem>
        <ShowcaseItem label="blockies — rounded square, corners preserved" inline>
          <WalletIdenticon seed={SEED} iconStyle="blockies" size={32} />
          <WalletIdenticon seed={SEED} iconStyle="blockies" size={48} />
        </ShowcaseItem>
        <ShowcaseItem label="no seed → fallbackIcon" inline>
          <WalletIdenticon size={48} />
          <WalletIdenticon size={48} fallbackIcon="security" />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection
        title="PoolDrepAvatar"
        description="Stake-pool / DRep avatar — remote image when the pool has one, initials from the label otherwise."
      >
        <ShowcaseItem label="initials fallback" inline>
          <PoolDrepAvatar label="BLOOM" />
          <PoolDrepAvatar label="BLOOM" size={48} />
          <PoolDrepAvatar label="Ada Pool" size={48} />
        </ShowcaseItem>
        <ShowcaseItem label="with image" inline>
          <PoolDrepAvatar label="BLOOM" imageUrl={fakeImages.green} size={48} />
          <PoolDrepAvatar label="BLOOM" imageUrl={fakeImages.amber} size={64} />
        </ShowcaseItem>
        <ShowcaseItem label="null image → initials" inline>
          <PoolDrepAvatar label="BLOOM" imageUrl={null} size={48} />
        </ShowcaseItem>
      </ShowcaseSection>

      <ShowcaseSection title="Side by side" description="All four at 48px, for direct comparison.">
        <ShowcaseItem label="IdentityAvatar · AuthorAvatar · WalletIdenticon · PoolDrepAvatar" inline>
          <View style={styles.row}>
            <IdentityAvatar size={48} pnyxId={PNYX_ID_A} />
            <AuthorAvatar author={PNYX_ID_A} size={48} />
            <WalletIdenticon seed={SEED} size={48} />
            <PoolDrepAvatar label="BLOOM" size={48} />
          </View>
        </ShowcaseItem>
      </ShowcaseSection>
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.spacing16,
  },
}))
