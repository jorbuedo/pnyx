/**
 * Icon mapping registry for UniIcon component.
 *
 * Maps icon names to their SVG source files.
 *
 * @module
 */

/**
 * General UI icons - Stroke versions.
 */
export const iconSources = {
  // Arrows & chevrons
  arrows: require('../../../assets/icons/Arrows.svg'),
  arrowLeft: require('../../../assets/icons/ArrowLeft.svg'),
  arrowRight: require('../../../assets/icons/ArrowRight.svg'),
  arrowUpRight: require('../../../assets/icons/ArrowUpRight.svg'),
  arrowLineDown: require('../../../assets/icons/ArrowLineDown.svg'),
  angleDown: require('../../../assets/icons/AngleDown.svg'),
  chevronLeft: require('../../../assets/icons/ChevronLeft.svg'),
  chevronRight: require('../../../assets/icons/ChevronRight.svg'),
  chevronDown: require('../../../assets/icons/ChevronDown.svg'),
  downThin: require('../../../assets/icons/DownThin.svg'),
  rightThin: require('../../../assets/icons/RightThin.svg'),
  // Status & feedback
  check: require('../../../assets/icons/Check.svg'),
  info: require('../../../assets/icons/Info.svg'),
  infoFilled: require('../../../assets/icons/InfoFilled.svg'),
  alert: require('../../../assets/icons/Alert.svg'),
  alertFilled: require('../../../assets/icons/AlertFilled.svg'),
  successFilled: require('../../../assets/icons/SuccessFilled.svg'),
  warning: require('../../../assets/icons/Warning.svg'),
  warningFilled: require('../../../assets/icons/WarningFilled.svg'),
  pending: require('../../../assets/icons/Pending.svg'),
  questionMark: require('../../../assets/icons/QuestionMark.svg'),
  clock: require('../../../assets/icons/Clock.svg'),
  // Security & signing
  star: require('../../../assets/icons/Star.svg'),
  starFilled: require('../../../assets/icons/StarFilled.svg'),
  security: require('../../../assets/icons/Security.svg'),
  securityWarning: require('../../../assets/icons/SecurityWarning.svg'),
  shieldCheck: require('../../../assets/icons/ShieldCheck.svg'),
  lock: require('../../../assets/icons/Lock.svg'),
  lockOpen: require('../../../assets/icons/LockOpen.svg'),
  faceID: require('../../../assets/icons/FaceID.svg'),
  sign: require('../../../assets/icons/Sign.svg'),
  // Money & wallet
  wallet: require('../../../assets/icons/Wallet.svg'),
  walletFilled: require('../../../assets/icons/WalletFilled.svg'),
  coins: require('../../../assets/icons/Coins.svg'),
  currency: require('../../../assets/icons/Currency.svg'),
  send: require('../../../assets/icons/Send.svg'),
  receive: require('../../../assets/icons/Deposit.svg'),
  swap: require('../../../assets/icons/Swap.svg'),
  backUp: require('../../../assets/icons/BackUp.svg'),
  growthStaking: require('../../../assets/icons/GrowthStaking.svg'),
  // Identity & social
  account: require('../../../assets/icons/Account.svg'),
  accountFilled: require('../../../assets/icons/AccountFilled.svg'),
  manageAccount: require('../../../assets/icons/ManageAccount.svg'),
  community: require('../../../assets/icons/Community.svg'),
  chat: require('../../../assets/icons/Chat.svg'),
  chatFilled: require('../../../assets/icons/ChatFilled.svg'),
  notification: require('../../../assets/icons/Notification.svg'),
  bell: require('../../../assets/icons/Bell.svg'),
  campaign: require('../../../assets/icons/Campaign.svg'),
  email: require('../../../assets/icons/Email.svg'),
  support: require('../../../assets/icons/Support.svg'),
  // Devices & scanning
  trezor: require('../../../assets/icons/Trezor.svg'),
  ledger: require('../../../assets/icons/Ledger.svg'),
  usb: require('../../../assets/icons/Usb.svg'),
  bluetooth: require('../../../assets/icons/Bluetooth.svg'),
  scan: require('../../../assets/icons/Scan.svg'),
  qr: require('../../../assets/icons/Qr.svg'),
  // Content & links
  document: require('../../../assets/icons/Document.svg'),
  fileText: require('../../../assets/icons/FileText.svg'),
  layers: require('../../../assets/icons/Layers.svg'),
  hash: require('../../../assets/icons/Hash.svg'),
  link: require('../../../assets/icons/Link.svg'),
  chain: require('../../../assets/icons/Chain.svg'),
  blockExplorer: require('../../../assets/icons/BlockExplorer.svg'),
  globe: require('../../../assets/icons/Globe.svg'),
  language: require('../../../assets/icons/Language.svg'),
  tabBrowser: require('../../../assets/icons/TabBrowser.svg'),
  // Actions & editing
  copy: require('../../../assets/icons/Copy.svg'),
  copyFilled: require('../../../assets/icons/CopyFilled.svg'),
  pencilOutline: require('../../../assets/icons/PencilOutline.svg'),
  delete: require('../../../assets/icons/TrashOutline.svg'),
  deleteFilled: require('../../../assets/icons/DeleteFilled.svg'),
  plus: require('../../../assets/icons/Plus.svg'),
  minus: require('../../../assets/icons/Minus.svg'),
  close: require('../../../assets/icons/Close.svg'),
  filter: require('../../../assets/icons/Filter.svg'),
  search: require('../../../assets/icons/Search.svg'),
  refresh: require('../../../assets/icons/Refresh.svg'),
  share: require('../../../assets/icons/Share.svg'),
  settings: require('../../../assets/icons/Settings.svg'),
  backspace: require('../../../assets/icons/Backspace.svg'),
  hide: require('../../../assets/icons/Hide.svg'),
  reveal: require('../../../assets/icons/Reveal.svg'),
  // Menus
  menu: require('../../../assets/icons/Menu.svg'),
  moreHorizontal: require('../../../assets/icons/MoreHorizontal.svg'),
  moreVertical: require('../../../assets/icons/MoreVertical.svg'),
  // Theme
  lightMode: require('../../../assets/icons/LightMode.svg'),
  nightMode: require('../../../assets/icons/NightMode.svg'),
  systemDefaultTheme: require('../../../assets/icons/SystemDefaultTheme.svg'),
  lightbulb: require('../../../assets/icons/Lightbulb.svg'),
  // Onboarding tiles
  tileQuickstart: require('../../../assets/icons/TileQuickstart.svg'),
  tileCreateWallet: require('../../../assets/icons/TileCreateWallet.svg'),
  tileRecoveryPhrase: require('../../../assets/icons/TileRecoveryPhrase.svg'),
  tilePasskey: require('../../../assets/icons/TilePasskey.svg'),
  tileHardwareWallet: require('../../../assets/icons/TileHardwareWallet.svg'),
  tileMultisigWallet: require('../../../assets/icons/TileMultisigWallet.svg'),
  tileImportBackup: require('../../../assets/icons/TileImportBackup.svg'),
  tileWatchOnly: require('../../../assets/icons/TileWatchOnly.svg'),
  // Never pass `color` to this one — it is Google's four-colour mark and a tint flattens it to
  // mono, which their sign-in branding rules forbid.
  tileSocialGoogle: require('../../../assets/icons/TileSocialGoogle.svg'),
  tileSocialApple: require('../../../assets/icons/TileSocialApple.svg'),
  tileSocialX: require('../../../assets/icons/TileSocialX.svg'),
  tileSocialEmail: require('../../../assets/icons/TileSocialEmail.svg'),
  // Brand
  pnyxLogo: require('../../../assets/icons/PnyxLogo.svg'),
  midnight: require('../../../assets/icons/NightDark.svg'),
}

/**
 * All icon sources combined.
 */
export const allIconSources = {
  ...iconSources,
}

/**
 * Type for all available icon names.
 */
export type UniIconName = keyof typeof allIconSources
