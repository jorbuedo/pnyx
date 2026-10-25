/**
 * The avatar for an **Pnyx identity** (`pnyx_id`).
 *
 * Deliberately not `WalletIdenticon`, for two reasons. A funds wallet keeps Blockies/Jazzicon
 * because other wallets render the same blockie for the same Cardano/EVM address, and that
 * cross-app recognisability is worth more than nicer art; an `pnyx_id` appears in no other app.
 * And `WalletIdenticon` calls `useWalletList()`, which would subscribe every row of a chat list to
 * wallet-state changes — the reason `AuthorAvatar` used to inline its own renderer.
 *
 * **Seeded by the public identity, never by anything only its owner can compute.** The avatar is a
 * shared visual: a peer holding just your `pnyx_id` must render exactly what you see. Seeded by
 * the *bytes* of `C` rather than the bech32m text — see `identity-avatar-seed.ts` for why the text
 * is not canonical enough to draw a face from.
 *
 * ⚠️ **Recognition, never verification** — see `@pnyx/identicon`'s `Multiavatar`. ~2^33.5 possible
 * avatars means one that looks like yours can be ground out in minutes, so no surface may let the
 * avatar alone stand for an identity. Show the `pnyx_id` wherever the user commits to a peer.
 *
 * @module
 */

import {Multiavatar} from '@pnyx/identicon'
import {useMemo} from 'react'
import {View} from 'react-native'
import {SvgXml} from 'react-native-svg'
import {StyleSheet} from 'react-native-unistyles'
import {identityAvatarSeed} from './identity-avatar-seed'
import {UniIcon} from './UniIcon'

export type IdentityAvatarProps = {
  /**
   * The `pnyx_id` to render. Absent — or anything that does not decode as one — renders the
   * placeholder, never a stand-in avatar.
   */
  readonly pnyxId?: string | undefined
  readonly size?: number
  readonly testID?: string
}

export const IdentityAvatar = ({pnyxId, size = 40, testID}: IdentityAvatarProps) => {
  const svg = useMemo(() => {
    if (pnyxId === undefined) return null
    const seed = identityAvatarSeed(pnyxId)
    return seed === null ? null : Multiavatar({seed}).asSvg()
  }, [pnyxId])

  return (
    <View style={[styles.container, {width: size, height: size, borderRadius: size / 2}]} testID={testID}>
      {svg === null ? (
        <UniIcon name="account" size="sm" uniProps={(theme) => ({color: theme.colors.textMuted})} />
      ) : (
        <SvgXml xml={svg} width={size} height={size} />
      )}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    backgroundColor: theme.colors.backgroundAlternative,
  },
}))
