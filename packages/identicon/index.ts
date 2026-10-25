/**
 * @pnyx/identicon
 *
 * Deterministic identicon generation and CIP4 wallet checksum utilities.
 *
 * @example
 * ```ts
 * import {Blockies, walletChecksum} from '@pnyx/identicon'
 *
 * const checksum = walletChecksum(accountPublicKeyHex)
 * const identicon = Blockies({seed: checksum.seed}).asBase64()
 * ```
 *
 * @module
 */

export {Blockies} from './blockies.js'
export {type WalletChecksum, walletChecksum} from './checksum.js'
export {colorSaturation} from './color-saturation.js'
export {type ColorScheme, colorScheme} from './color-scheme.js'
export {Jazzicon} from './jazzicon.js'
export {Multiavatar, type MultiavatarOptions, type MultiavatarResult} from './multiavatar.js'
export {type WalletProfile, walletProfile} from './wallet-profile.js'
