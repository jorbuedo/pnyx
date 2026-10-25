import {Asset} from 'expo-asset'
import {logger} from '../logger'

export const loadTextAsset = async (assetModule: string): Promise<string> => {
  try {
    const asset = Asset.fromModule(assetModule)
    await asset.downloadAsync()

    if (asset.localUri) {
      const response = await fetch(asset.localUri)
      const text = await response.text()
      return text
    }

    throw new Error('Failed to load asset')
  } catch (error) {
    logger.error('Error loading text asset', {origin: 'loadTextAsset', cause: error})
    return ''
  }
}
