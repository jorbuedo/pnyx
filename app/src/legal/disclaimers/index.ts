import {loadTextAsset} from '../loadTextAsset'

export type DisclaimerType = 'dapp' | 'shareWallet' | 'thirdParty'

const dappFallback: string = require('./dapp/en-US.md')
const shareWalletFallback: string = require('./shareWallet/en-US.md')
const thirdPartyFallback: string = require('./thirdParty/en-US.md')

const dappAssetMap: Record<string, string> = {
  'en-US': dappFallback,
  'es-ES': require('./dapp/es-ES.md'),
  'ja-JP': require('./dapp/ja-JP.md'),
  'zh-CN': require('./dapp/zh-CN.md'),
  'zh-TW': require('./dapp/zh-TW.md'),
}

const shareWalletAssetMap: Record<string, string> = {
  'en-US': shareWalletFallback,
  'es-ES': require('./shareWallet/es-ES.md'),
  'ja-JP': require('./shareWallet/ja-JP.md'),
  'zh-CN': require('./shareWallet/zh-CN.md'),
  'zh-TW': require('./shareWallet/zh-TW.md'),
}

const thirdPartyAssetMap: Record<string, string> = {
  'en-US': thirdPartyFallback,
  'es-ES': require('./thirdParty/es-ES.md'),
  'ja-JP': require('./thirdParty/ja-JP.md'),
  'zh-CN': require('./thirdParty/zh-CN.md'),
  'zh-TW': require('./thirdParty/zh-TW.md'),
}

const fallbackAssets: Record<DisclaimerType, string> = {
  dapp: dappFallback,
  shareWallet: shareWalletFallback,
  thirdParty: thirdPartyFallback,
}

const assetMaps: Record<DisclaimerType, Record<string, string>> = {
  dapp: dappAssetMap,
  shareWallet: shareWalletAssetMap,
  thirdParty: thirdPartyAssetMap,
}

export const loadDisclaimer = async (type: DisclaimerType, languageCode: string): Promise<string> => {
  const map = assetMaps[type]
  const asset = map[languageCode] ?? fallbackAssets[type]
  return loadTextAsset(asset)
}
