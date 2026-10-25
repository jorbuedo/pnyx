/**
 * Reusable wallet identicon component.
 *
 * Engine is selected per-wallet via `WalletProfile.iconStyle`:
 *  - `'jazzicon'` (default) — Jazzicon, the app-native style. The engine clips
 *    to a circle itself (`clip: 'circle'`), so circular is its authored form.
 *  - `'blockies'` — Ethereum-style 8×8 grid; pinned for legacy-imported
 *    wallets so users recognise their wallet visually.
 *
 * **Shape follows the engine.** Blockies is emitted as a plain square and its
 * corner cells carry signal: an inscribed circle discards 4 of 64 cells
 * outright and clips 28 more — 21.5% of the image area, and 2 of the 32 unique
 * cells (the grid is horizontally mirrored). So blockies renders as a rounded
 * square, the way MetaMask and Etherscan draw it, while jazzicon stays round.
 *
 * When no `seed` is provided, automatically uses the selected wallet group's
 * primary wallet checksum seed.
 *
 * @module
 */

import {Blockies, Jazzicon} from '@pnyx/identicon'
import type {WalletProfile} from '@pnyx/wallet'
import {useMemo} from 'react'
import {View} from 'react-native'
import {SvgXml} from 'react-native-svg'
import {StyleSheet} from 'react-native-unistyles'

import {useWalletList} from '../providers'
import {UniIcon} from './UniIcon'

type WalletIdenticonProps = {
  /** Checksum seed used to generate the identicon. When omitted or undefined, uses the selected wallet group's seed. */
  readonly seed?: string | undefined
  /**
   * Identicon engine override. When omitted, reads from the selected wallet
   * group's `profile.iconStyle`, defaulting to `'jazzicon'`.
   */
  readonly iconStyle?: WalletProfile['iconStyle']
  /** Overall container size in pixels (default: 40) */
  readonly size?: number
  /** Fallback icon name when no seed is available */
  readonly fallbackIcon?: 'walletFilled' | 'security'
  /** Test ID for e2e testing */
  readonly testID?: string
}

// The Jazzicon engine requires a hexadecimal seed (it drives a Mersenne-Twister
// PRNG). Wallet checksum seeds are already hex, but other callers pass
// arbitrary strings (e.g. a bech32 identity address `mn_addr1…`). Normalize any
// non-hex seed to hex by encoding its UTF-8 bytes — deterministic and valid,
// so the identicon is stable per seed. Already-hex seeds pass through unchanged
// (existing wallet identicons are unaffected).
const HEX_SEED = /^(0x)?[0-9a-fA-F]+$/
const toHexSeed = (seed: string): string =>
  HEX_SEED.test(seed)
    ? seed
    : Array.from(seed)
        .map((ch) => ch.charCodeAt(0).toString(16).padStart(2, '0'))
        .join('')

const renderIdenticon = (style: WalletProfile['iconStyle'], rawSeed: string, size: number): string => {
  const seed = toHexSeed(rawSeed)
  // Blockies' `size` is the grid-cell count (default 8), not pixels — `scale`
  // is pixels-per-cell. Use the defaults so we get the canonical 8×8 pattern
  // and let SvgXml scale it to the container size.
  if (style === 'blockies') return Blockies({seed}).asSvg()
  return Jazzicon({seed}).asSvg({size, clip: 'circle'})
}

export const WalletIdenticon = (props: WalletIdenticonProps) => {
  const {size = 40, fallbackIcon = 'walletFilled', testID} = props
  const {selectedWalletGroup} = useWalletList()
  // Per WalletProfile: legacy-imported wallets pin `iconSeed` to their xpub
  // so Blockies renders the same image the user saw before import. Other wallets
  // fall through to the checksum-derived seed.
  const profileSeed = selectedWalletGroup?.profile?.iconSeed
  const checksumSeed = selectedWalletGroup?.primaryWallet.checksum?.seed
  const resolvedSeed = 'seed' in props ? props.seed : (profileSeed ?? checksumSeed)
  const resolvedStyle: WalletProfile['iconStyle'] =
    props.iconStyle ?? selectedWalletGroup?.profile?.iconStyle ?? 'jazzicon'

  const identiconSvg = useMemo(() => {
    if (!resolvedSeed) return null
    return renderIdenticon(resolvedStyle, resolvedSeed, size)
  }, [resolvedSeed, resolvedStyle, size])

  styles.useVariants({shape: resolvedStyle === 'blockies' ? 'square' : 'circle'})

  return (
    <View
      testID={testID}
      style={[
        styles.container,
        {
          width: size,
          height: size,
        },
      ]}
    >
      {identiconSvg ? (
        <SvgXml xml={identiconSvg} width={size} height={size} />
      ) : (
        <UniIcon name={fallbackIcon} size="md" uniProps={(theme) => ({color: theme.colors.primaryDefault})} />
      )}
    </View>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden',
    variants: {
      shape: {
        circle: {borderRadius: theme.borderRadius.roundedCircle},
        square: {borderRadius: theme.borderRadius.rounded8},
      },
    },
  },
}))
