/**
 * Backup file save/pick for React Native.
 *
 * Save writes the text to a cache file and hands it to the OS share sheet
 * (expo-sharing); pick uses the document picker and reads the file's text.
 *
 * @module
 */

import * as DocumentPicker from 'expo-document-picker'
import {File, Paths} from 'expo-file-system'
import * as Sharing from 'expo-sharing'

export type PickedBackupFile = {readonly name: string; readonly text: string}

export const saveBackupTextFile = async ({
  fileName,
  text,
}: {
  readonly fileName: string
  readonly text: string
}): Promise<void> => {
  const file = new File(Paths.cache, fileName)
  file.create({overwrite: true, intermediates: true})
  file.write(text)
  // Throw (rather than silently no-op) when the OS share sheet is unavailable so
  // the caller surfaces its "save failed" toast instead of appearing to succeed.
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is unavailable on this device')
  }
  await Sharing.shareAsync(file.uri, {mimeType: 'application/json', UTI: 'public.json', dialogTitle: fileName})
}

export const pickBackupTextFile = async (): Promise<PickedBackupFile | null> => {
  // `*/*` so a custom `.cardanobackup` extension is selectable; content is JSON.
  const result = await DocumentPicker.getDocumentAsync({type: '*/*', copyToCacheDirectory: true, multiple: false})
  const asset = result.canceled ? null : result.assets[0]
  if (!asset) return null
  const text = await new File(asset.uri).text()
  return {name: asset.name, text}
}
