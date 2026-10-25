/**
 * Avatar for a message author.
 *
 * **Only a disclosed author gets an avatar**, and the reason is not cosmetic. The avatar is
 * derived from the author's `pnyx_id`, so it says something about *which key* posted. A display
 * name is not a key — personas are unique
 * only *within* a circle (`personaTaken` in the content service), so the same name,
 * and therefore the same generated image, can be a different person in another
 * community. Deriving a blockie from a pseudonym would hand users a recognisable
 * badge that anyone else can mint, which is worse than no badge at all.
 *
 * So a pseudonym gets a deliberately non-identifying monogram: one letter, one
 * neutral colour, no derivation from the name beyond the initial the name already
 * shows. It keeps rows aligned and it looks nothing like a fingerprint. That rule matters *more*
 * now the disclosed case is a memorable character rather than a pixel blob: an appealing avatar
 * attached to a persona would be a far stickier cross-circle identifier.
 *
 * ⚠️ Even for a disclosed author the avatar is **recognition, not proof** — one that looks like
 * someone else's can be ground out cheaply (see `@pnyx/identicon`'s `Multiavatar`). The actions
 * that matter show the `pnyx_id`.
 *
 * @module
 */

import {View} from 'react-native'
import {StyleSheet} from 'react-native-unistyles'
import {authorIdentity} from '../../services/pnyx-forum'
import {IdentityAvatar} from '../IdentityAvatar'
import {Typography} from '../Typography'

export type AuthorAvatarProps = {
  /** The author string as the service returned it: an `pnyx_id` or a display name. */
  readonly author: string
  readonly size?: number
}

/** First character, uppercased. Empty authors cannot happen, but render blank rather than crash. */
const monogramOf = (author: string): string => (author.length === 0 ? '' : author.slice(0, 1).toUpperCase())

export const AuthorAvatar = ({author, size = 32}: AuthorAvatarProps) => {
  const pnyxId = authorIdentity(author)

  if (pnyxId === null) {
    return (
      <View style={[styles.monogram, {width: size, height: size, borderRadius: size / 2}]}>
        <Typography variant="bodyXs_medium" style={styles.monogramText}>
          {monogramOf(author)}
        </Typography>
      </View>
    )
  }

  return <IdentityAvatar pnyxId={pnyxId} size={size} />
}

const styles = StyleSheet.create(({colors}) => ({
  monogram: {
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    flexShrink: 0,
    backgroundColor: colors.backgroundAlternative,
    borderWidth: 1,
    borderColor: colors.borderDefaultWeak,
  },
  monogramText: {
    color: colors.textMuted,
  },
}))
