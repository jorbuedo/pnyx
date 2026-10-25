/**
 * The mark on an account we vouch for.
 *
 * ⚠️ **It means "this `pnyx_id` is ours", not "this name is genuine".** Names are not policed — every
 * script is allowed and confusables are deliberately not rejected — so the mark attaches to a
 * commitment nobody else can hold, and an unmarked account calling itself "Pnyx Support" is exactly
 * what this does *not* prevent. The in-app "Ask support" action is the mitigation for that; this is
 * the confirmation once you are already looking at a conversation.
 *
 * ⚠️ **One tier on purpose.** No partner/team/staff gradation until a second kind of vouching
 * actually exists — a scale of trust badges invites a reader to rank them, and we would be inventing
 * the ranking.
 *
 * @module
 */

import {View} from 'react-native'
import {useI18n} from '../providers'
import {UniIcon, type UniIconSize} from './UniIcon'

export type OfficialMarkProps = {
  /** Matches the surrounding text. `xxs` (16px) sits with body copy. */
  readonly size?: UniIconSize | undefined
  readonly testID?: string | undefined
}

export const OfficialMark = ({size = 'xxs', testID = 'official-mark'}: OfficialMarkProps) => {
  const {t} = useI18n()
  return (
    // The label lives on a wrapper because `UniIcon` is a `withUnistyles` image and takes no
    // accessibility props: a screen reader must still be told the name carries a vouch.
    <View accessible accessibilityLabel={t('you.official.mark')} testID={testID}>
      {/* Explicit colour, never the SVG's baked-in fill: without it `tintColor` is null and the asset
          renders in whatever near-black it was exported with, which disappears on a dark surface. */}
      <UniIcon name="shieldCheck" size={size} uniProps={(theme) => ({color: theme.colors.primaryDefault})} />
    </View>
  )
}
