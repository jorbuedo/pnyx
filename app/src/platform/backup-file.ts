/**
 * Backup file save/pick for web + extension.
 *
 * Save is a Blob + object-URL download; pick is a transient `<input type=file>`.
 * No remote code, no eval, no injected script — safe under the extension RHC policy.
 *
 * @module
 */

import {logger} from '../logger'

export type PickedBackupFile = {readonly name: string; readonly text: string}

export const saveBackupTextFile = async ({
  fileName,
  text,
}: {
  readonly fileName: string
  readonly text: string
}): Promise<void> => {
  const url = URL.createObjectURL(new Blob([text], {type: 'application/json'}))
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = fileName
    a.rel = 'noopener'
    document.body.appendChild(a)
    a.click()
    a.remove()
  } finally {
    // Revoke on the next tick so the download has a chance to start first.
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}

export const pickBackupTextFile = (): Promise<PickedBackupFile | null> =>
  new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.cardanobackup,.json,application/json,text/plain'
    let settled = false
    const done = (value: PickedBackupFile | null): void => {
      if (settled) return
      settled = true
      input.remove()
      resolve(value)
    }
    input.addEventListener(
      'change',
      () => {
        const file = input.files?.[0]
        if (!file) return done(null)
        file
          .text()
          .then((text) => done({name: file.name, text}))
          .catch((e) => {
            // `null` also means "cancelled", so an unreadable file needs saying out loud.
            logger.warn('Picked backup file could not be read', {
              origin: 'backup-file',
              name: file.name,
              error: String(e),
            })
            done(null)
          })
      },
      {once: true},
    )
    // Modern Chromium/Firefox (the web + extension targets) fire `cancel` when
    // the picker is dismissed — the reliable "user backed out" signal.
    input.addEventListener('cancel', () => done(null), {once: true})
    document.body.appendChild(input)
    input.click()
  })
