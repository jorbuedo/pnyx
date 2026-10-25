/**
 * A wallet, as a selectable row: blockie, name, and an optional note about what it can do.
 *
 * One implementation because this row is the same row everywhere — the link-action sheet's
 * "pay from" list, the multi-party composer's funding picker — and the seed it draws from
 * is not obvious enough to re-derive per call site. `accountIdenticonSeed(checksum ?? groupId, 0)`
 * is the identity of the picture; getting it wrong shows a different wallet's blockie next
 * to the right wallet's name, which is worse than showing none.
 *
 * The anatomy comes from {@link Row}; what this adds is the selection surface and the radio
 * semantics, which a plain list row has no business carrying.
 *
 * @module
 */

import {type ReactNode, useState} from 'react'
import {Pressable} from 'react-native'

import {accountIdenticonSeed} from '../utils/account-display'
import {ChamferBackground} from './Chamfer'
import {Row} from './Row'
import {WalletIdenticon} from './WalletIdenticon'

export type WalletRowProps = {
  readonly groupId: string
  readonly name: string
  /** `primaryWallet.checksum.seed` when there is one — the blockie is derived from it. */
  readonly checksumSeed?: string | undefined
  /** A short note about this wallet in this context: "Watched", "Needs co-signers". */
  readonly note?: string | undefined
  readonly selected?: boolean | undefined
  readonly onPress?: (() => void) | undefined
  /** Anything to show at the far end — a figure, a chevron. */
  readonly right?: ReactNode
  readonly testID?: string | undefined
}

export const WalletRow = ({groupId, name, checksumSeed, note, selected, onPress, right, testID}: WalletRowProps) => {
  // The surface is painted, not a background style, so the press state has to be
  // readable at render time rather than only inside Pressable's style callback.
  const [isPressed, setIsPressed] = useState(false)
  // A token name rather than a resolved colour: resolving it here would need a `useUnistyles()`
  // subscription, which opts this row out of the native theme update — see `ChamferPaintProps`.
  const surfaceToken = isPressed
    ? 'backgroundAlternativeHover'
    : selected === true
      ? 'backgroundAlternative'
      : undefined

  return (
    <Pressable
      onPress={onPress}
      disabled={onPress === undefined}
      onPressIn={() => setIsPressed(true)}
      onPressOut={() => setIsPressed(false)}
      accessibilityRole={selected === undefined ? 'button' : 'radio'}
      {...(selected === undefined ? {} : {accessibilityState: {selected}})}
      accessibilityLabel={name}
      testID={testID}
    >
      {surfaceToken !== undefined && <ChamferBackground size="auto" fillToken={surfaceToken} />}
      <Row
        leftContent={
          <WalletIdenticon seed={accountIdenticonSeed(checksumSeed ?? groupId, 0)} iconStyle="blockies" size={32} />
        }
        label={name}
        {...(note !== undefined && note !== '' ? {subtitle: note} : {})}
        rightContent={right}
      />
    </Pressable>
  )
}
