/**
 * Clipboard utility for React Native using expo-clipboard.
 *
 * @module
 */

import * as Clipboard from 'expo-clipboard'

export const copyToClipboard = async (text: string): Promise<void> => {
  await Clipboard.setStringAsync(text)
}
