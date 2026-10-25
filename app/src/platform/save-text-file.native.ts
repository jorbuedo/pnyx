/**
 * Save a text file on React Native — write to the cache dir and hand it to the
 * OS share sheet (expo-sharing). Mirrors `backup-file.native.ts` but takes the
 * MIME type / UTI so any text format (CSV, JSON, …) can be exported.
 *
 * @module
 */

import {File, Paths} from 'expo-file-system'
import * as Sharing from 'expo-sharing'

export type SaveTextFileInput = {
  readonly fileName: string
  readonly text: string
  readonly mimeType: string
  /** Apple Uniform Type Identifier (iOS share sheet). */
  readonly uti?: string
}

export const saveTextFile = async ({fileName, text, mimeType, uti}: SaveTextFileInput): Promise<void> => {
  const file = new File(Paths.cache, fileName)
  file.create({overwrite: true, intermediates: true})
  file.write(text)
  // Throw (rather than silently no-op) when the share sheet is unavailable so
  // the caller surfaces its failure toast instead of appearing to succeed.
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Sharing is unavailable on this device')
  }
  await Sharing.shareAsync(file.uri, {mimeType, ...(uti !== undefined ? {UTI: uti} : {}), dialogTitle: fileName})
}
